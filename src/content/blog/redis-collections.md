---
title: 'Redis 컬렉션 활용 전략'
description: 'Redis는 문자열 말고도 List, Hash, Set, Sorted Set 같은 여러 자료구조를 제공합니다. 자료구조별 특징과 카운팅·메시징에서 고르는 기준, 큰 컬렉션을 다룰 때 조심할 점을 정리합니다.'
pubDate: '2026-03-26T13:00:00+09:00'
updatedDate: '2026-09-29'
tags: ['redis', 'data-structure', 'cache', 'database']
series:
  id: redis
  order: 4
  label: '컬렉션 활용'
---

Redis와 Memcached는 둘 다 메모리에 키와 값을 두는 캐시로 많이 쓰이지만, Redis는 스스로를 자료구조 서버(data structure server)라고 소개합니다.
문자열 말고도 List, Hash, Set, Sorted Set, Stream 같은 컬렉션을 서버 안에 두고, 이것을 다루는 명령을 제공합니다.

차이는 동시에 고칠 때 드러납니다. 친구 목록을 문자열 하나에 직렬화해 두고, 두 요청이 동시에 친구 B와 C를 추가한다고 해 봅시다.
두 요청이 각자 A만 든 목록을 읽고, 자기 친구를 붙여 다시 쓰면 결과는 A, B나 A, C가 되어 한쪽 추가가 사라집니다.
Set에 `SADD`로 넣으면 이런 일이 없습니다. Redis는 요청을 한 번에 하나씩 차례로 처리하므로 명령 하나가 다른 명령과 섞이지 않고, 결과는 A, B, C가 됩니다.
애플리케이션에서 읽고, 고치고, 다시 쓰던 일을 명령 하나로 서버에서 끝낼 수 있습니다. 다만 버튼을 빠르게 두 번 눌러 같은 요청이 두 번 오는 것처럼, 요청 자체가 중복되는 문제까지 막아 주지는 않습니다.

이 글은 자료구조별 특징과, 무엇을 세거나 주고받을 때 어떤 자료구조를 고를지, 운영할 때 조심할 점을 정리합니다.

- **카운팅:** 단순히 늘리고 줄이면 String의 `INCR`, 사용자별 여부는 Bitmap, 아주 많은 값의 유니크 수는 HyperLogLog를 씁니다.
- **메시징:** 단순한 작업 큐는 List, 처리 확인과 재처리가 필요하면 Stream을 씁니다. Pub/Sub은 메시지를 저장하지 않습니다.
- **랭킹:** Sorted Set을 씁니다. 추가와 순위 조회가 O(log N)입니다.
- **운영:** 컬렉션 하나를 너무 크게 만들지 않고, 만료는 키 단위로만 걸린다는 점(7.4부터 Hash 필드는 예외)을 염두에 둡니다.

## 자료구조 한눈에 보기

| 자료구조 | 한 줄 설명 | 대표 명령 | 비용 |
| --- | --- | --- | --- |
| String | 바이트열, 값 하나 최대 512MB | `SET`, `GET`, `INCR` | 대부분 O(1) |
| Bitmap | String을 비트 배열로 다루는 명령 | `SETBIT`, `BITCOUNT`, `BITOP` | 비트 하나는 O(1) |
| List | 삽입 순서를 지키는 목록 | `LPUSH`, `RPOP`, `BLPOP`, `LRANGE` | 양 끝은 O(1), 중간은 O(N) |
| Hash | 키 하나 안의 필드-값 쌍 | `HSET`, `HGET`, `HGETALL` | 대부분 O(1), 전체 조회는 O(N) |
| Set | 순서 없고 중복 없는 집합 | `SADD`, `SISMEMBER`, `SINTER` | 대부분 O(1) |
| Sorted Set | 점수 순으로 정렬된 집합 | `ZADD`, `ZRANGE`, `ZRANK` | 대부분 O(log N) |
| HyperLogLog | 서로 다른 값의 개수를 추정 | `PFADD`, `PFCOUNT` | 최대 12KB |
| Stream | 추가만 하는 로그 | `XADD`, `XREADGROUP`, `XACK` | 추가는 O(1) |

## String과 Bitmap

**String**은 가장 기본인 타입으로, 바이트열을 그대로 담습니다. 텍스트, 직렬화한 객체, JPEG 이미지 같은 바이너리도 넣을 수 있고, 값 하나는 최대 512MB입니다.

- `SET`, `GET`, 여러 키를 한 번에 다루는 `MSET`, `MGET`을 씁니다.
- `INCR`, `DECR`, `INCRBY`로 숫자를 늘리고 줄입니다. 값은 10진수 64비트 부호 있는 정수로 해석하고, 정수로 볼 수 없으면 오류가 납니다.
- `INCR`은 원자적입니다. 두 클라이언트가 동시에 10을 읽고 둘 다 11을 쓰는 일은 일어나지 않습니다. 읽고, 더하고, 쓰는 동안 다른 클라이언트의 명령이 끼어들지 않기 때문입니다.
- 대부분의 명령은 O(1)입니다. `GETRANGE`, `SETRANGE`, `SUBSTR`은 O(N)이라 큰 문자열에서는 조심해야 합니다.

**Bitmap**은 따로 있는 타입이 아니라, String을 비트 배열로 다루는 명령 묶음입니다. 문자열이 최대 512MB라서 비트를 2^32개까지 쓸 수 있습니다.

- `SETBIT`, `GETBIT`으로 비트 하나를 켜고 끄고 읽습니다. 둘 다 O(1)입니다.
- `BITCOUNT`로 켜진 비트 수를 세고, `BITPOS`로 처음 켜지거나 꺼진 비트를 찾습니다.
- `BITOP`으로 여러 비트맵을 AND, OR, XOR, NOT으로 합칩니다. 8.2부터는 `DIFF`, `DIFF1`, `ANDOR`, `ONE`도 있습니다.
- 공식 문서의 예로, 사용자 ID가 차례로 늘어나는 정수라면 사용자 40억 명의 예/아니요 정보(예: 뉴스레터 수신 여부)를 512MB에 담을 수 있습니다.

## List

List는 삽입 순서를 지키는 문자열 목록이고, 연결 리스트로 구현되어 있습니다.

- 원소가 몇백만 개여도 양 끝에 넣고 빼는 `LPUSH`, `RPUSH`, `LPOP`, `RPOP`은 O(1)입니다.
- 인덱스로 중간에 접근하는 `LINDEX`, `LINSERT`, `LSET`은 O(N)입니다. `LRANGE`도 O(N)이지만, 양 끝 쪽의 작은 범위를 읽는 것은 상수 시간입니다.
- 내부적으로는 3.2부터 작은 노드를 이어 붙인 quicklist를 쓰고(노드 안쪽 형식은 7.0부터 listpack), 원소가 적은 리스트는 7.2부터 listpack 하나로 저장합니다.
- 최대 길이는 2^32 - 1입니다.

쓰임새는 크게 둘입니다.

- **최근 목록:** 새 게시물 ID를 `LPUSH`로 넣고 `LRANGE 0 9`로 최근 10개를 읽습니다. `LTRIM`으로 최근 N개만 남기면 크기가 일정한 목록이 됩니다.
- **작업 큐:** 생산자가 `LPUSH`로 넣고 소비자가 `RPOP`으로 꺼냅니다. Ruby의 resque와 sidekiq가 이렇게 List로 백그라운드 작업 큐를 만듭니다.

큐가 비었을 때 `RPOP`을 계속 부르는 폴링은 빈 응답만 오가는 명령을 늘리고, 다음 시도까지 기다리는 만큼 처리도 늦어집니다.
`BLPOP`, `BRPOP`은 목록이 비어 있으면 원소가 들어오거나 타임아웃이 될 때까지 기다렸다가 돌려주므로 폴링이 필요 없습니다.

큰 목록의 중간에 자주 접근해야 한다면 List보다 Sorted Set이 맞습니다.

## Hash

Hash는 키 하나 안에 필드-값 쌍을 여러 개 담습니다. 관계형 DB의 행 하나나 객체 하나를 담기 좋습니다.

- 객체를 JSON으로 직렬화해 String에 넣으면 필드 하나를 고칠 때도 전체를 읽고 다시 써야 합니다. Hash는 `HGET`, `HSET`으로 필드 단위로 읽고 쓸 수 있어 주고받는 데이터가 줄어듭니다.
- 대부분의 명령은 O(1)이고, `HGETALL`, `HKEYS`, `HVALS`는 필드 수만큼 O(N)입니다.
- 필드는 2^32 - 1개까지 넣을 수 있지만, 실제로는 메모리가 한계입니다.
- 필드가 적은 Hash(기본값: 필드 512개 이하, 값 64바이트 이하)는 listpack이라는 촘촘한 형식으로 저장되어 메모리를 훨씬 덜 씁니다. 공식 문서는 이런 작은 컬렉션이 최대 10배, 평균 5배 메모리를 덜 쓴다고 설명합니다. 기준을 넘으면 일반 해시 테이블로 바뀝니다.
- 7.4부터는 필드마다 만료를 걸 수 있습니다(`HEXPIRE`, `HPEXPIRE`, `HTTL`, `HPERSIST` 등). 8.0부터는 값을 읽거나 쓰면서 만료를 함께 정하는 `HGETEX`, `HSETEX`도 있습니다.

## Set

Set은 순서가 없고 중복이 없는 문자열 집합입니다.

- `SADD`, `SREM`, `SISMEMBER` 같은 대부분의 명령은 O(1)입니다. 값이 있는지 확인할 때 List처럼 훑을 필요가 없습니다.
- `SINTER`, `SUNION`, `SDIFF`로 교집합, 합집합, 차집합을 서버에서 계산합니다. 팔로워나 친구 관계, 태그처럼 객체 사이의 관계를 담기 좋습니다.
- `SMEMBERS`는 O(N)이고 전체를 한 응답으로 돌려줍니다. 공식 문서는 원소가 수십만 개를 넘는 Set에서는 조심하고, `SSCAN`으로 나눠 읽으라고 권합니다.
- 최대 크기는 2^32 - 1개입니다. 정수만 든 작은 Set은 intset(기본 512개 이하)으로, 7.2부터는 작은 Set도 listpack(기본 128개 이하, 값 64바이트 이하)으로 저장합니다.

## Sorted Set

Sorted Set은 Set의 각 원소에 점수(score)를 붙여 점수 순으로 정렬해 둔 것입니다. 점수가 같으면 원소 문자열의 사전순으로 정렬합니다.

- 스킵 리스트와 해시 테이블을 함께 씁니다. 그래서 추가, 삭제, 순위 조회(`ZRANK`)는 O(log N), 원소의 점수 조회(`ZSCORE`)는 O(1), 범위 조회(`ZRANGE`)는 O(log N + M)입니다(M은 돌려주는 개수).
- 실시간 순위표에 많이 씁니다. `ZADD`로 점수를 넣거나 `ZINCRBY`로 더하고, `ZRANGE ... REV`로 상위권을 읽습니다.
- 원소가 적은 Sorted Set(기본 128개 이하, 값 64바이트 이하)은 listpack으로 저장합니다.

점수에서 조심할 점이 둘 있습니다.

- **점수는 64비트 부동소수점(double)입니다.** -(2^53)부터 +(2^53)까지의 정수는 정확히 표현하지만, 그보다 큰 정수나 소수는 근삿값이 될 수 있습니다. 시각과 점수를 한 숫자로 합친 복합 점수를 만들 때는 이 범위를 넘지 않는지 봐야 합니다.
- **점수가 같으면 사전순입니다.** 대기열처럼 순서가 중요한데 점수가 겹칠 수 있다면, 사전순이 원하는 순서가 아닐 수 있습니다. [선착순 대기열 글](/blog/kopang-queue-fairness-remeasure/)에서는 같은 밀리초에 들어온 요청이 토큰(UUID)의 사전순으로 줄을 서서 사실상 무작위가 되었습니다.

## HyperLogLog

HyperLogLog는 원소를 저장하지 않고, 지금까지 넣은 서로 다른 원소의 개수(카디널리티)를 추정합니다.

- 표준 오차는 0.81%입니다.
- 메모리는 최대 12KB입니다. 6비트 카운터 16384개(12,288바이트)를 쓰는 dense 표현이 최대이고, 넣은 원소가 적을 때는 sparse 표현으로 훨씬 적게 씁니다. 늘 12KB를 차지하는 것은 아닙니다.
- `PFADD`로 넣고 `PFCOUNT`로 개수를 추정하고, `PFMERGE`로 여러 개를 합칩니다. 넣은 원소를 다시 꺼낼 수는 없습니다.
- 공식 문서가 드는 쓰임은 하루 동안 검색된 서로 다른 검색어 수, 웹 페이지의 순 방문자 수 같은 것입니다.

Set으로 같은 일을 하면 원소 수에 비례해 메모리가 늘어납니다. 약간의 오차를 받아들일 수 있다면 HyperLogLog가 훨씬 가볍습니다.

## Stream

Stream은 5.0에 들어온, 추가만 하는(append-only) 로그 자료구조입니다.

- `XADD`로 항목을 추가합니다. 항목 ID는 기본으로 `<밀리초 시각>-<순번>` 형식이라, `XRANGE`로 시간 범위를 지정해 읽을 수 있습니다.
- `XREAD BLOCK`으로 새로 들어오는 항목만 기다렸다 받을 수 있습니다. 서버 로그를 `tail -f`로 보는 것과 비슷합니다.
- 컨슈머 그룹(`XREADGROUP`)을 쓰면 그룹 안의 컨슈머들이 서로 다른 메시지를 나눠 받습니다. 처리한 메시지는 `XACK`로 알리고, 아직 확인되지 않은 메시지(pending)는 그룹이 따로 기억합니다. 처리하던 컨슈머가 죽으면 다른 컨슈머가 `XCLAIM`이나 `XAUTOCLAIM`(6.2부터)으로 가져가 다시 처리할 수 있습니다.
- 컨슈머 그룹이라는 이름은 Kafka에서 빌려 왔습니다. 공식 문서는 기능이 비슷해 용어를 가져왔을 뿐, 구현은 Kafka의 컨슈머 그룹과 관계가 없다고 밝힙니다.

Stream이 메시지를 저장한다고 해서 영속성이 보장되는 것은 아닙니다. 다른 자료구조와 똑같이 RDB나 AOF로 디스크에 저장되고, 레플리카에는 비동기로 복제됩니다.
공식 문서는 메시지를 잃으면 안 된다면 AOF를 강한 fsync 정책으로 쓰라고 하고, 기본인 비동기 복제에서는 장애 조치 뒤에 일부 `XADD`나 컨슈머 그룹 상태가 빠져 있을 수 있다고 적고 있습니다([HA 글](/blog/redis-high-availability/)).
Stream을 메시지 큐 후보로 다른 선택지와 비교한 과정은 [재고 동기화용 메시지 큐 고르기](/blog/kopang-ec-mq-choice/)에 정리했습니다.

## 카운팅: 무엇을 셀 것인가

정확해야 하는지, 메모리를 얼마나 쓸 수 있는지에 따라 고릅니다.

| 방식 | 자료구조 | 특징 | 쓰임 |
| --- | --- | --- | --- |
| 단순 증감 | String | `INCR`로 원자적으로 셉니다. 가장 단순합니다. | 조회수, 좋아요 수 |
| 사용자별 여부 | Bitmap | 사용자 ID를 비트 위치로 써서 1비트에 한 명을 담습니다. 1,000만 명이면 약 1.2MB입니다. | 일별 접속자 수, 출석 체크 |
| 대량의 유니크 수 | HyperLogLog | 오차(표준 오차 0.81%)를 받아들이는 대신 최대 12KB만 씁니다. | 방문 IP 수, 검색어 수 |

Bitmap으로 일별 접속자를 세려면 날짜별 키를 두고 접속한 사용자의 ID 위치에 `SETBIT <날짜 키> <사용자 ID> 1`로 비트를 켠 뒤, `BITCOUNT`로 셉니다. 여러 날의 비트맵을 `BITOP AND`로 합치면 며칠 내내 접속한 사용자도 서버에서 바로 구할 수 있습니다.

Bitmap을 쓸 때는 사용자 ID 모양을 봐야 합니다.

- ID가 0 이상의 정수여야 하고, 비트 위치는 2^32 - 1까지만 쓸 수 있습니다.
- ID가 띄엄띄엄 크면 메모리를 낭비합니다. 1번과 40억 번 사용자 둘만 있어도 40억 번째 비트까지 약 500MB를 잡습니다.
- 처음 쓰는 키나 짧은 문자열에 큰 위치의 비트를 켜면, 그 앞까지의 메모리를 한꺼번에 할당하느라 서버가 잠시 멈출 수 있습니다.

## 메시징: 무엇을 주고받을 것인가

| 방식 | 자료구조 | 동작 | 맞는 경우 |
| --- | --- | --- | --- |
| 단순 큐 | List | `LPUSH`로 넣고 `BRPOP`으로 꺼냅니다. | 작업 대기열 |
| 있는 목록에만 추가 | List | `RPUSHX`, `LPUSHX`는 키가 이미 있을 때만 넣습니다. | 캐시에 올라와 있는 타임라인만 갱신 |
| 이벤트 로그 | Stream | 컨슈머 그룹, 처리 확인(`XACK`), 재처리를 지원합니다. | 처리 확인과 재처리가 필요한 메시지 |
| 방송 | Pub/Sub | 저장하지 않고 지금 구독 중인 클라이언트에게만 보냅니다. | 놓쳐도 되는 실시간 알림 |

**단순 큐의 약점:** `BRPOP`으로 꺼낸 순간 메시지는 목록에서 사라집니다. 소비자가 꺼낸 뒤 처리하기 전에 죽으면 그 메시지는 잃습니다.
공식 문서는 `LMOVE`(막히는 버전은 `BLMOVE`)로 꺼내면서 처리 중 목록에 옮겨 두고, 처리가 끝나면 `LREM`으로 지우는 방법을 소개합니다. 처리 중 목록에 너무 오래 남은 메시지는 다른 클라이언트가 다시 큐에 넣으면 됩니다.

**`RPUSHX`와 트위터의 타임라인:** 트위터는 사용자마다 홈 타임라인을 Redis List에 두고, 최근 30일 안에 로그인한 활성 사용자의 타임라인만 메모리에 올려 둡니다([High Scalability 정리](https://highscalability.com/the-architecture-twitter-uses-to-deal-with-150m-active-users/)).
새 트윗을 팔로워들의 타임라인에 넣을 때는 `RPUSHX`로 캐시에 있는 타임라인에만 추가합니다([Raffi Krikorian의 발표 자료](https://speakerdeck.com/angelbotto/raffi-krikorian-twitter-timelines-at-scale)). 활성 사용자가 아니면 키 자체가 없으니 아무 일도 일어나지 않고, 드물게 오는 사용자를 위해 타임라인을 미리 쌓아 두는 낭비가 없습니다.

**Pub/Sub과 Stream:** Pub/Sub은 메시지를 저장하지 않고 보내는 순간 구독 중인 클라이언트에게만 전달합니다. 공식 문서의 표현으로 최대 한 번(at-most-once) 전달이라, 구독자가 없거나 연결이 끊겨 있었다면 그 메시지는 영영 사라집니다.
Stream은 메시지를 로그에 남겨 두므로 나중에 다시 읽거나 재처리할 수 있습니다.

## 운영에서 조심할 것

### 컬렉션 하나를 너무 크게 만들지 않기

Redis는 요청을 한 번에 하나씩 처리합니다. 오래 걸리는 명령 하나가 도는 동안 다른 명령은 모두 기다립니다. 1초 걸리는 명령이 하나 끼면, 그 뒤에 들어온 명령은 모두 1초 가까이 기다리다 타임아웃에 걸릴 수 있습니다.

컬렉션이 크면 이런 명령이 생기기 쉽습니다.

- 전체를 읽는 명령(`HGETALL`, `SMEMBERS`, `LRANGE 0 -1`, `ZRANGE 0 -1`)은 원소 수만큼 걸리고, 그만큼 큰 응답을 만들어 보냅니다.
- 키를 지우는 `DEL`도 원소 수만큼 걸립니다. 원소 수백만 개짜리 키라면 몇 초까지 멈출 수 있습니다.

[우아한레디스 발표](https://www.youtube.com/watch?v=mPB2CZiAkKM)에서는 컬렉션 하나에 1만 개 이하, 몇천 개 수준을 권합니다. 큰 컬렉션은 여러 키로 쪼개 담습니다. 키 관리는 번거로워지지만 성능을 위해 감수하는 비용입니다.
공식 메모리 최적화 문서에도 비슷한 예가 있습니다. `object:1234` 같은 키를 `object:12` 해시의 `34` 필드로 바꿔 담으면 해시 하나에 필드가 100개 안팎으로 유지되고, 작은 Hash의 촘촘한 형식 덕분에 메모리도 아낍니다.

어떤 키가 큰지는 `redis-cli --bigkeys`(원소 수 기준)와 `redis-cli --memkeys`(메모리 기준)로 찾을 수 있습니다. 둘 다 `SCAN`으로 키 공간을 훑습니다.

### O(N) 명령 대신 쓸 것

| 피할 명령 | 대신 쓸 것 |
| --- | --- |
| `KEYS` | `SCAN`. 호출 한 번은 O(1)이고, 커서로 조금씩 나눠 훑으니 그 사이에 다른 명령이 실행됩니다. |
| `SMEMBERS`, `HGETALL`, `ZRANGE 0 -1` | `SSCAN`, `HSCAN`, `ZSCAN`, 또는 필요한 범위만 읽기(예: `ZRANGE key 0 99`) |
| 큰 키의 `DEL` | `UNLINK`(4.0부터). 키 공간에서 떼어 내기만 하고 메모리 해제는 백그라운드 스레드가 맡습니다. |
| `FLUSHALL`, `FLUSHDB` | `ASYNC` 옵션을 붙여 백그라운드에서 비우기 |

`KEYS`에 대해 공식 문서는 운영 환경에서는 매우 조심해서 쓰고 일반 애플리케이션 코드에서는 쓰지 말라고 경고합니다. 보통 노트북에서 키 100만 개를 훑는 데 40ms가 걸리는데, 그동안 다른 요청은 모두 기다립니다.
`KEYS`는 ACL의 `@dangerous` 분류에 들어 있어서, 애플리케이션 계정에 `-@dangerous`를 주면 아예 쓰지 못하게 막을 수 있습니다.

`SCAN` 계열은 한 번에 조금씩 돌려주는 대신, 순회하는 동안 추가되거나 지워진 원소가 결과에 나올지는 보장이 약합니다. 한 번 호출에 몇 개가 돌아올지도 정해져 있지 않으니, 커서가 0이 될 때까지 이어서 호출해야 합니다.

### 만료는 키 단위로 걸립니다

`EXPIRE`는 키 전체에 걸립니다. List, Set, Sorted Set의 원소 하나에는 만료를 따로 걸 수 없습니다.
그래서 원소 1만 개짜리 컬렉션 키에 만료를 걸면, 시간이 되었을 때 1만 개가 한꺼번에 지워집니다. 이 해제도 기본으로는 메인 스레드에서 일어나므로, 큰 컬렉션이 만료되는 순간 서버가 멈칫할 수 있습니다. `lazyfree-lazy-expire yes`로 두면 백그라운드에서 해제합니다.

몇 가지를 덧붙입니다.

- **예외: Hash 필드.** 7.4부터 Hash는 필드마다 만료를 걸 수 있습니다.
- **만료 시각에 바로 지워지지는 않습니다.** 만료된 키는 누군가 접근할 때 발견되어 지워지거나, 백그라운드에서 키 공간을 조금씩 훑는 작업(active expire)이 찾아 지웁니다.
- **원소마다 만료가 필요하면:** Sorted Set에 만료 시각을 점수로 넣어 두고, 주기적으로 `ZREMRANGEBYSCORE <키> -inf <현재 시각>`으로 지난 원소를 지우는 방법이 있습니다.

## 정리

1. 메모리를 아끼면서 세야 하면 Bitmap이나 HyperLogLog를 봅니다. Bitmap은 ID가 촘촘한 정수여야 하고, HyperLogLog는 0.81% 안팎의 오차를 받아들여야 합니다.
2. 큐가 필요하면 단순한 경우는 List를, 처리 확인과 재처리가 필요하면 Stream을 씁니다. 어느 쪽이든 디스크 영속성은 RDB/AOF 설정을 따릅니다.
3. 순위는 Sorted Set으로 만듭니다. 점수의 정밀도(±2^53)와 동점일 때의 사전순을 확인합니다.
4. 컬렉션 하나가 너무 커지지 않게 설계하고 `--bigkeys`로 지켜봅니다. 만료는 키 단위라는 점을 염두에 둡니다.

## 참고 자료

- [Redis 문서: Understand Redis data types](https://redis.io/docs/latest/develop/data-types/)
- [Redis 문서: Strings](https://redis.io/docs/latest/develop/data-types/strings/), [Bitmaps](https://redis.io/docs/latest/develop/data-types/strings/bitmaps/)
- [Redis 문서: Lists](https://redis.io/docs/latest/develop/data-types/lists/), [Hashes](https://redis.io/docs/latest/develop/data-types/hashes/), [Sets](https://redis.io/docs/latest/develop/data-types/sets/), [Sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/)
- [Redis 문서: HyperLogLog](https://redis.io/docs/latest/develop/data-types/probabilistic/hyperloglogs/), [PFCOUNT](https://redis.io/docs/latest/commands/pfcount/)
- [Redis 문서: Streams](https://redis.io/docs/latest/develop/data-types/streams/)
- [Redis 문서: Pub/Sub](https://redis.io/docs/latest/develop/pubsub/)
- [Redis 문서: INCR](https://redis.io/docs/latest/commands/incr/), [SETBIT](https://redis.io/docs/latest/commands/setbit/), [BITOP](https://redis.io/docs/latest/commands/bitop/), [ZADD](https://redis.io/docs/latest/commands/zadd/), [LMOVE](https://redis.io/docs/latest/commands/lmove/), [KEYS](https://redis.io/docs/latest/commands/keys/), [SCAN](https://redis.io/docs/latest/commands/scan/), [UNLINK](https://redis.io/docs/latest/commands/unlink/)
- [Redis 문서: Memory optimization](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/)
- [Redis 문서: Redis CLI – Scan for big keys](https://redis.io/docs/latest/develop/tools/cli/)
- [Redis 문서: Diagnosing latency issues](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/)
- [High Scalability: The Architecture Twitter Uses to Deal with 150M Active Users](https://highscalability.com/the-architecture-twitter-uses-to-deal-with-150m-active-users/)
- [Raffi Krikorian, Timelines at Scale 발표 자료](https://speakerdeck.com/angelbotto/raffi-krikorian-twitter-timelines-at-scale)
- [[우아한테크세미나] 191121 우아한레디스 by 강대명님](https://www.youtube.com/watch?v=mPB2CZiAkKM)
