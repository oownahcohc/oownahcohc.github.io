---
title: 'InnoDB와 PostgreSQL 비교: 옛 행 버전을 어디에 두느냐가 바꾸는 것들'
description: 'MySQL(InnoDB)과 PostgreSQL은 둘 다 MVCC지만, 행을 고칠 때 옛 버전을 두는 곳이 다릅니다. 이 차이가 테이블 크기와 청소, REPEATABLE READ의 동작, 잠금 방식까지 어떻게 바꾸는지 두 DB에서 같은 실험으로 확인합니다.'
pubDate: '2026-09-27'
tags: ['mysql', 'postgresql', 'innodb', 'database', 'transaction', 'concurrency']
draft: true
---

MySQL을 쓸 때는 보통 InnoDB를 씁니다. MySQL은 SQL을 해석하는 층과 데이터를 저장하는 층(스토리지 엔진)이 나뉘어 있어서, 테이블마다 저장 엔진을 고를 수 있기 때문입니다([MySQL 아키텍처](/blog/mysql-architecture/)).
PostgreSQL에는 이런 선택지가 사실상 없습니다. 저장 방식이 본체에 하나로 들어 있고, 그 방식을 힙(heap)이라고 부릅니다. 12 버전부터 테이블 저장 방식을 바꿔 끼울 수 있는 API(Table Access Method)가 생겼지만, 운영 환경은 거의 전부 기본값인 `heap`을 씁니다.

그러면 InnoDB와 힙은 무엇이 다를까요. 버퍼 풀과 `shared_buffers`, 리두 로그와 WAL처럼 짝이 맞는 부품이 많아 비슷해 보이지만, 가장 큰 차이는 한 곳에서 갈립니다. **행을 고칠 때 옛 버전을 어디에 두는가**입니다.
이 차이가 테이블 모양, 청소 방식, 격리 수준의 동작, 잠금 방식까지 이어집니다.

이 글은 두 DB를 나란히 띄워 같은 실험을 하며 그 차이를 확인한 기록입니다. InnoDB 내부 구조는 [Real MySQL 8.0 정리](/blog/mysql-architecture/) 시리즈에서 다뤘으니, 여기서는 PostgreSQL과 갈리는 지점에 집중합니다.

결과를 먼저 요약하면 이렇습니다.

- **테이블 모양:** InnoDB 테이블은 PK 순서로 정렬된 B-Tree(클러스터드 인덱스)이고, PostgreSQL 테이블은 순서 없는 힙입니다. PostgreSQL에서는 UPDATE한 행이 다른 자리로 옮겨 갑니다.
- **옛 버전:** InnoDB는 행을 제자리에서 고치고 옛 값을 언두 로그로 옮깁니다. PostgreSQL은 테이블 안에 새 버전을 한 줄 더 쓰고, 옛 버전은 VACUUM이 치울 때까지 남습니다. 오래 열린 트랜잭션 아래서 10만 행 전체 UPDATE를 세 번 하자 PostgreSQL 테이블은 13MB에서 54MB로 커졌고, InnoDB는 테이블 대신 언두 테이블스페이스가 16MB에서 32MB로 커졌습니다.
- **REPEATABLE READ:** 이름은 같은데 동작이 다릅니다. 읽은 값으로 계산해 덮어쓰는 사이에 다른 트랜잭션이 먼저 커밋하면, MySQL은 그 변경을 덮어써 잃어버렸고 PostgreSQL은 직렬화 오류로 트랜잭션을 실패시켰습니다.
- **잠금:** MySQL은 범위를 잠그면 레코드 사이의 간격까지 잠가, 조회 범위 밖 값의 INSERT까지 기다리게 했습니다. PostgreSQL에는 갭 락이 없어 INSERT가 바로 들어갔습니다. 행 1만 개를 잠그면 InnoDB는 메모리 잠금 테이블에 10,084개 항목을 올렸고, PostgreSQL은 잠금 테이블 항목 3개로 끝내는 대신 행마다 잠근 트랜잭션 번호를 적었습니다.

실험은 Docker로 띄운 MySQL 8.0.46과 PostgreSQL 16.14에서 했고, 설정은 모두 기본값입니다.
두 DB는 행 형식이 달라 같은 데이터라도 파일 크기가 다르므로, 크기는 같은 DB 안에서 전후만 비교합니다.

## 테이블 모양: 클러스터드 인덱스와 힙

InnoDB 테이블은 그 자체가 PK로 정렬된 B-Tree입니다. 이를 클러스터드 인덱스라고 부르고, 행 데이터는 이 트리의 리프 페이지에 PK 순서대로 들어 있습니다.
보조 인덱스의 리프에는 행 위치 대신 PK 값이 들어 있어서, 보조 인덱스로 찾으면 그 PK로 클러스터드 인덱스를 한 번 더 탑니다.

PostgreSQL 테이블은 행을 순서 없이 쌓아 두는 힙입니다. 각 행은 `ctid`라는 물리 위치(페이지 번호, 페이지 안 칸 번호)를 가지고, PK 인덱스를 포함한 모든 인덱스가 이 `ctid`를 가리킵니다.
PostgreSQL에서 PK는 "유일하고 NULL이 없는 인덱스"일 뿐, 테이블의 저장 순서를 정하지 않습니다.

id를 3, 1, 2 순서로 넣고 그대로 읽어 보면 차이가 드러납니다. `ORDER BY` 없는 조회 순서는 어느 DB에서도 보장되지 않으니, 저장 모양을 들여다보는 용도로만 봐 주세요.

```sql
CREATE TABLE member (id int PRIMARY KEY, name varchar(10));
INSERT INTO member VALUES (3, 'c'), (1, 'a'), (2, 'b');
SELECT * FROM member;                       -- PostgreSQL은 ctid도 함께 조회
UPDATE member SET name = 'A' WHERE id = 1;
SELECT * FROM member;
```

| 시점 | MySQL (InnoDB) | PostgreSQL (id와 `ctid`) |
| --- | --- | --- |
| INSERT 직후 | 1, 2, 3 | 3 `(0,1)`, 1 `(0,2)`, 2 `(0,3)` |
| id=1 UPDATE 뒤 | 1, 2, 3 | 3 `(0,1)`, 2 `(0,3)`, 1 `(0,4)` |

InnoDB는 넣은 순서와 상관없이 PK 순서로 돌려줍니다. PostgreSQL은 넣은 순서대로 쌓았고, id=1을 고치자 그 행이 `(0,2)`에서 `(0,4)`로 옮겨 갔습니다. 이 "옮겨 간다"가 다음 절의 주제입니다.

이 모양 차이는 PK를 고를 때도 드러납니다. InnoDB에서 무작위 UUID처럼 순서 없는 PK를 쓰면 새 행이 클러스터드 인덱스의 아무 페이지에나 끼어들어, 테이블 자체에서 페이지 분할이 잦아집니다. PostgreSQL은 테이블은 계속 뒤에 쌓고 PK 인덱스만 흩어지니 영향이 인덱스에 그칩니다.
반대로 PK로 한 행을 읽을 때 InnoDB는 트리를 한 번 타면 행까지 닿지만, PostgreSQL은 인덱스에서 `ctid`를 얻은 뒤 힙 페이지를 한 번 더 읽습니다.
이 차이가 인덱스 크기와 범위 조회에 미치는 영향은 [인덱스 구조 비교](/blog/index-structure-innodb-vs-postgresql/)에서 따로 다뤘습니다.

## 옛 버전은 어디에 남는가

두 DB 모두 MVCC를 씁니다. 행을 고쳐도 옛 버전을 한동안 남겨 두고, 트랜잭션마다 자기 시점에 맞는 버전을 보여 주는 방식입니다. 차이는 옛 버전을 두는 곳입니다.

InnoDB는 행을 제자리에서 고치고, 고치기 전 값을 언두 로그로 옮깁니다([리두 로그와 언두 로그](/blog/innodb-redo-undo-log/)).
옛 시점을 봐야 하는 트랜잭션은 행에서 출발해 언두 로그를 거슬러 올라가며 자기 버전을 찾습니다. 테이블에는 늘 최신 버전 한 줄만 있습니다.

PostgreSQL은 UPDATE를 "옛 버전을 지운 것으로 표시하고 새 버전을 새로 쓰기"로 처리합니다. 행마다 머리 부분에 그 버전을 만든 트랜잭션 번호(`xmin`)와 지운 트랜잭션 번호(`xmax`)가 있어서, 이 둘로 어느 트랜잭션에게 보일지 판단합니다.
행 세 개짜리 테이블에서 한 행을 고친 뒤 `pageinspect` 확장으로 페이지를 열어 보면, 옛 버전이 그대로 남아 있습니다.

```sql
CREATE TABLE account (id int PRIMARY KEY, balance int NOT NULL);
INSERT INTO account VALUES (1, 100), (2, 100), (3, 100);   -- 트랜잭션 734
UPDATE account SET balance = 90 WHERE id = 2;              -- 트랜잭션 735

SELECT lp, lp_flags, t_ctid, t_xmin, t_xmax
FROM heap_page_items(get_raw_page('account', 0));
```

```text
 lp | lp_flags | t_ctid | t_xmin | t_xmax
----+----------+--------+--------+--------
  1 |        1 | (0,1)  |    734 |      0
  2 |        1 | (0,4)  |    734 |    735
  3 |        1 | (0,3)  |    734 |      0
  4 |        1 | (0,4)  |    735 |      0
```

행은 세 개인데 페이지에는 네 줄이 있습니다. 2번 칸이 id=2의 옛 버전입니다. `t_xmax`에 735가 적혀 "735가 지운 버전"이 되었고, `t_ctid`로 새 버전이 있는 4번 칸을 가리킵니다.
735가 커밋되기 전에 스냅숏을 잡은 트랜잭션은 2번 칸을, 그 뒤의 트랜잭션은 4번 칸을 봅니다.

이 옛 버전을 치우는 것이 VACUUM입니다. 더 이상 어떤 트랜잭션도 볼 수 없게 된 버전을 찾아 자리를 비웁니다.
VACUUM 뒤 같은 페이지를 다시 열면 2번 칸의 내용이 사라지고 `lp_flags`가 2(redirect)로 바뀌어 있습니다. PK 인덱스는 여전히 2번 칸을 가리키고 있으니, 그 칸을 새 버전이 있는 4번 칸으로 넘겨주는 안내판으로 남긴 것입니다. 인덱스를 고치지 않고 이렇게 넘어갈 수 있는 것은 뒤에서 다룰 HOT 업데이트 덕분입니다.

```text
 lp | lp_flags | t_ctid | t_xmin | t_xmax
----+----------+--------+--------+--------
  1 |        1 | (0,1)  |    734 |      0
  2 |        2 |        |        |
  3 |        1 | (0,3)  |    734 |      0
  4 |        1 | (0,4)  |    735 |      0
```

InnoDB에도 청소가 있습니다. 퍼지(purge) 스레드가 더는 필요 없는 언두 기록을 지웁니다. 다만 치우는 대상이 테이블 밖의 언두 로그라는 점이 다릅니다.
PostgreSQL의 VACUUM은 테이블 자체를 청소하는 일이라 운영에서 차지하는 비중이 훨씬 큽니다. 기본으로 켜져 있는 autovacuum이 이 일을 자동으로 합니다.

## 오래 열린 트랜잭션 아래서 UPDATE하면

옛 버전을 두는 곳이 다르면, 옛 버전이 쌓일 때 커지는 곳도 다릅니다. 옛 버전은 그것을 볼 수 있는 트랜잭션이 하나라도 남아 있으면 지울 수 없으니, 오래 열린 트랜잭션이 있을 때 차이가 가장 크게 드러납니다.

10만 행 테이블을 두 DB에 똑같이 만들고, 한 세션에서 REPEATABLE READ 트랜잭션을 열어 한 번 읽어 둔 채 40초를 기다리게 했습니다. 그동안 다른 세션에서 전체 행을 고치는 UPDATE를 세 번 실행했습니다.

```sql
CREATE TABLE t (id int PRIMARY KEY, v int NOT NULL, pad char(100) NOT NULL DEFAULT 'x');
-- 10만 행을 넣고, 다른 세션이 스냅숏을 연 채로
UPDATE t SET v = v + 1;   -- 세 번
```

| 항목 | 처음 | UPDATE 3번 뒤 (스냅숏 열림) | 스냅숏 닫고 청소한 뒤 |
| --- | --- | --- | --- |
| PostgreSQL 테이블 | 13MB | 54MB | 54MB |
| PostgreSQL PK 인덱스 | 2.2MB | 6.6MB | 6.6MB |
| PostgreSQL 죽은 버전 | 0 | 30만 개, 지울 수 없음 | 0 (30만 개 제거) |
| InnoDB 테이블 파일 (`t.ibd`) | 21MB | 21MB | 21MB |
| InnoDB 언두 테이블스페이스 (`undo_001`) | 16MB | 32MB | 32MB |

PostgreSQL 테이블은 행마다 버전이 네 개(살아 있는 것 1개, 죽은 것 3개)가 되면서 약 4배로 커졌습니다. 스냅숏이 열려 있는 동안 VACUUM을 돌리면 이렇게 보고합니다.

```text
tuples: 0 removed, 400000 remain, 300000 are dead but not yet removable
```

스냅숏을 닫은 뒤 다시 돌리자 30만 개가 모두 지워졌습니다(`300000 removed, 100000 remain`). 그래도 파일은 54MB 그대로입니다.
일반 VACUUM은 빈자리를 같은 테이블이 다시 쓰도록 표시할 뿐, 대부분의 경우 운영체제에 돌려주지 않습니다. 파일까지 줄이려면 테이블을 통째로 다시 쓰는 `VACUUM FULL`(도는 동안 테이블을 배타적으로 잠급니다)이나 pg_repack 같은 도구가 필요합니다.

InnoDB 테이블 파일은 크기가 그대로였습니다. 대신 옛 값이 옮겨 간 언두 테이블스페이스가 16MB에서 32MB로 커졌습니다.
스냅숏이 닫히자 퍼지가 언두 기록을 지웠지만, 이쪽 파일도 바로 줄지는 않습니다. MySQL 8.0은 언두 테이블스페이스가 `innodb_max_undo_log_size`(기본 1GB)를 넘으면 잘라 내 운영체제에 돌려줍니다(`innodb_undo_log_truncate`, 기본 켜짐).

오래 열린 트랜잭션은 두 DB 모두에서 해롭지만 증상이 다릅니다. PostgreSQL에서는 테이블과 인덱스가 부풀고(bloat), InnoDB에서는 언두가 쌓이고 옛 시점을 읽는 쿼리가 거슬러 올라갈 버전 사슬이 길어집니다.

### 인덱스 컬럼을 안 바꿔도 인덱스가 커진다

위 표에서 하나 더 볼 것은 PostgreSQL PK 인덱스입니다. UPDATE는 `v`만 바꾸고 PK인 `id`는 건드리지 않았는데도 인덱스가 2.2MB에서 6.6MB로 커졌습니다.
PostgreSQL 인덱스는 행의 물리 위치(`ctid`)를 가리키니, 새 버전이 다른 곳에 쓰이면 인덱스에도 새 항목이 필요하기 때문입니다.

이를 줄이는 장치가 HOT(Heap-Only Tuple) 업데이트입니다. 인덱스에 걸린 컬럼을 바꾸지 않았고 새 버전이 같은 페이지 안에 들어갈 자리가 있으면, 인덱스는 그대로 두고 페이지 안에서 옛 버전과 새 버전을 사슬로 잇습니다. 앞 절에서 VACUUM 뒤 2번 칸이 안내판으로 남은 것이 이 사슬의 흔적입니다.

HOT은 페이지에 빈자리가 있어야 하므로, 테이블의 `fillfactor`(페이지를 몇 %까지 채울지)에 좌우됩니다. 오래 열린 트랜잭션 없이 같은 전체 UPDATE를 세 번 하면서 `fillfactor`만 바꿔 봤습니다.

| fillfactor | UPDATE된 행 | 그중 HOT |
| --- | --- | --- |
| 100 (기본값) | 300,000 | 31 (0.0%) |
| 70 | 300,000 | 198,118 (66.0%) |

페이지를 꽉 채우는 기본값에서는 HOT이 거의 일어나지 않았고, 30%를 비워 두자 3분의 2가 HOT으로 처리됐습니다.
UPDATE가 잦은 테이블이라면 PostgreSQL에서는 `fillfactor`를 낮추고, 자주 바뀌는 컬럼에는 되도록 인덱스를 걸지 않는 편이 이득입니다. 인덱스에 걸린 컬럼을 바꾸면 HOT이 되지 않기 때문입니다.

InnoDB에는 이 문제가 없습니다. 행을 제자리에서 고치고 보조 인덱스는 행 위치가 아니라 PK 값을 가리키므로, 인덱스에 걸린 컬럼이나 PK를 바꾸지 않는 한 인덱스는 그대로입니다.

## 같은 REPEATABLE READ, 다른 동작

기본 격리 수준부터 다릅니다. MySQL(InnoDB)은 REPEATABLE READ이고, PostgreSQL은 READ COMMITTED입니다. 격리 수준 자체의 정의는 [트랜잭션 격리 수준](/blog/mysql-transaction-isolation-level/) 글에 정리해 두었습니다.
그런데 격리 수준을 REPEATABLE READ로 맞춰도 두 DB의 동작은 같지 않습니다.

### 읽고 계산해서 쓰면

잔액 100인 계좌에서 T1이 잔액을 읽고, 애플리케이션이 10을 뺀 값을 계산해 덮어쓰는 흐름입니다. 그 사이에 T2가 30을 빼고 먼저 커밋합니다. T1은 두 DB 모두 REPEATABLE READ로 실행했습니다.

| 순서 | T1 (REPEATABLE READ) | T2 |
| --- | --- | --- |
| 1 | `SELECT balance` → 100 | |
| 2 | | `SET balance = balance - 30`, 커밋 → 70 |
| 3 | `SELECT balance` → 100 (스냅숏) | |
| 4 | 100 - 10을 계산해 `SET balance = 90` | |

| DB | T1의 UPDATE | 최종 잔액 |
| --- | --- | --- |
| MySQL | 성공 (1행 변경) | 90 |
| PostgreSQL | `ERROR: could not serialize access due to concurrent update` | 70 |

MySQL에서는 T2가 뺀 30이 사라졌습니다. 갱신 손실(lost update)입니다.
InnoDB의 REPEATABLE READ에서 일반 SELECT는 스냅숏을 읽지만, UPDATE·DELETE와 잠금 읽기(`FOR UPDATE`)는 스냅숏이 아니라 가장 최근에 커밋된 행을 대상으로 동작합니다. 그리고 그 행이 스냅숏 이후 바뀌었는지는 따지지 않습니다. 그래서 옛 값으로 계산한 결과가 그대로 덮어써집니다.

PostgreSQL의 REPEATABLE READ는 스냅숏 격리입니다. 고치려는 행을 스냅숏 이후 다른 트랜잭션이 이미 고치고 커밋했다면, 그 위에 덮어쓰는 대신 트랜잭션을 실패시킵니다.
데이터는 지켜지지만, 애플리케이션이 이 오류(SQLSTATE `40001`)를 받아 트랜잭션을 처음부터 다시 실행해야 합니다.

조건을 바꾸면 결과도 달라집니다.

- UPDATE를 `SET balance = balance - 10`처럼 현재 값 기준으로 쓰면, MySQL은 최신 행(70)에서 10을 빼 60이라는 맞는 값을 냈습니다. PostgreSQL REPEATABLE READ는 이때도 같은 직렬화 오류를 냈습니다.
- PostgreSQL도 기본값인 READ COMMITTED에서는 오류 없이 90으로 덮어써, MySQL과 같은 갱신 손실이 났습니다.

읽고 계산해서 쓰는 흐름을 지키려면, 두 DB 모두 처음 읽을 때 `SELECT ... FOR UPDATE`로 잠그거나 버전 컬럼을 두고 `WHERE version = ?`로 확인하는 낙관적 잠금이 필요합니다. PostgreSQL에서 REPEATABLE READ 이상을 쓴다면 직렬화 오류를 받아 재시도하는 코드가 있어야 합니다.

### 범위를 잠그면: 갭 락

T1이 `id BETWEEN 1 AND 10` 범위를 `FOR UPDATE`로 잠근 채 3초를 기다리는 동안, T2가 id 5, 15, 25를 동시에 INSERT했습니다. 테이블에는 id 1, 2, 3, 20이 있습니다.

```sql
-- T1 (REPEATABLE READ)
SELECT id FROM item WHERE id BETWEEN 1 AND 10 FOR UPDATE;

-- T2 (세 문장을 동시에)
INSERT INTO item VALUES (5, 'new');    -- 범위 안
INSERT INTO item VALUES (15, 'new');   -- 범위 밖, 3과 20 사이
INSERT INTO item VALUES (25, 'new');   -- 범위 밖, 20 뒤
```

| T2의 INSERT | MySQL | PostgreSQL |
| --- | --- | --- |
| id 5 | 2.0초 기다림 (T1 커밋까지) | 바로 성공 |
| id 15 | 2.0초 기다림 | 바로 성공 |
| id 25 | 바로 성공 | 바로 성공 |

InnoDB가 T1에 걸어 둔 잠금은 이렇습니다(`performance_schema.data_locks`).

```text
+-----------+---------------+-----------+
| LOCK_TYPE | LOCK_MODE     | LOCK_DATA |
+-----------+---------------+-----------+
| TABLE     | IX            | NULL      |
| RECORD    | X,REC_NOT_GAP | 1         |
| RECORD    | X             | 2         |
| RECORD    | X             | 3         |
| RECORD    | X,GAP         | 20        |
+-----------+---------------+-----------+
```

2와 3에는 레코드와 그 앞 간격을 함께 잠그는 넥스트 키 락(`X`)이, 20에는 20 앞 간격만 잠그는 갭 락(`X,GAP`)이 걸렸습니다.
조회 범위는 10까지인데 3과 20 사이 간격 전체가 잠겼기 때문에, 범위 밖인 15도 기다려야 했습니다. InnoDB가 REPEATABLE READ에서 팬텀 리드를 막는 방법이 이렇게 간격에 새 행이 들어오지 못하게 하는 것입니다([InnoDB 스토리지 엔진 잠금](/blog/innodb-storage-engine-lock/)).

PostgreSQL에는 갭 락이 없습니다. INSERT는 모두 바로 들어갔고, T1이 3초 뒤 같은 조회를 다시 해도 결과는 여전히 1, 2, 3이었습니다. 새로 들어온 5는 T1의 스냅숏 이후에 커밋된 행이라 보이지 않기 때문입니다.
PostgreSQL은 팬텀 리드를 잠금이 아니라 스냅숏으로 막습니다.

대신 PostgreSQL의 REPEATABLE READ는 "범위에 행이 없으면 넣는다" 같은 규칙을 동시 실행에서 지켜 주지 않습니다. 두 트랜잭션이 각자의 스냅숏에서 "없음"을 보고 둘 다 넣을 수 있습니다.
이런 규칙은 유니크 제약으로 DB가 막게 하거나 SERIALIZABLE을 써야 합니다. PostgreSQL의 SERIALIZABLE은 SSI(Serializable Snapshot Isolation)로, 읽은 범위를 기록해 두었다가 직렬로 실행했을 때와 결과가 달라질 순서가 생기면 한쪽을 직렬화 오류로 실패시킵니다. 이 기록은 다른 트랜잭션을 기다리게 하지 않습니다.

### 행 잠금은 어디에 적히나

마지막으로 행 1만 개를 `SELECT ... FOR UPDATE`로 잠그고, 잠금 정보가 어디에 쌓이는지 봤습니다.

InnoDB는 잠금을 메모리의 잠금 테이블에 올립니다. `performance_schema.data_locks`에는 레코드 잠금이 10,084개 보였습니다. 행 1만 개에, 범위가 페이지를 넘어갈 때마다 페이지 끝(supremum)에 걸린 잠금 84개가 더해진 수입니다. `SHOW ENGINE INNODB STATUS`에는 이렇게 나옵니다.

```text
86 lock struct(s), heap size 24696, 10084 row lock(s)
```

InnoDB는 한 페이지 안의 행 잠금을 비트맵 하나에 모아 담기 때문에, 1만 행을 잠가도 잠금 구조체는 86개, 메모리는 약 24KB였습니다. 잠금을 이렇게 작게 관리하니 InnoDB에는 행 잠금을 테이블 잠금으로 키우는 락 에스컬레이션이 없습니다.

PostgreSQL의 잠금 테이블(`pg_locks`)에는 항목이 3개뿐이었습니다.

```text
   locktype    |     mode      | count
---------------+---------------+-------
 relation      | RowShareLock  |     2
 transactionid | ExclusiveLock |     1
```

테이블과 PK 인덱스에 거는 약한 잠금 둘, 그리고 T1 자신의 트랜잭션 번호에 대한 잠금 하나입니다. 행 잠금은 행 자체에 적혀 있습니다. 잠근 1만 행의 `xmax`를 보면 모두 T1의 트랜잭션 번호(787)입니다.

```text
 xmax | count
------+-------
    0 |     2
  787 | 10000
```

다른 트랜잭션이 이 행을 고치려 하면 `xmax`에서 787을 발견하고, 787번 트랜잭션에 대한 잠금(`transactionid`)이 풀리기를 기다립니다.
그래서 PostgreSQL은 행을 아무리 많이 잠가도 공유 메모리의 잠금 테이블이 넘치지 않습니다. 대신 행을 잠그는 것만으로도 페이지에 쓰기가 일어나고 WAL이 남습니다.
행에 적힌 트랜잭션 번호로 잠금 여부를 판단한다는 점은 [InnoDB INSERT의 암묵적 잠금](/blog/innodb-insert-lock/)과 발상이 같습니다.

## 나머지 부품 대응표

| 역할 | InnoDB | PostgreSQL |
| --- | --- | --- |
| 테이블 저장 | PK 순 B-Tree (클러스터드 인덱스) | 순서 없는 힙 |
| 보조 인덱스가 가리키는 것 | PK 값 | 행 위치 (`ctid`) |
| 옛 버전 | 언두 로그, 퍼지 스레드가 청소 | 테이블 안, VACUUM(autovacuum)이 청소 |
| 데이터 캐시 | 버퍼 풀 | `shared_buffers`와 운영체제 페이지 캐시 |
| 변경 기록 | 리두 로그 | WAL |
| 페이지 일부만 기록되는 문제 대비 | 더블 라이트 버퍼 | `full_page_writes` |
| 체인지 버퍼, 어댑티브 해시 인덱스 | 있음 | 없음 |
| 커넥션 처리 | 커넥션마다 스레드 | 커넥션마다 프로세스 |

몇 가지는 설명을 붙입니다.

- **캐시 크기:** 둘 다 기본값은 128MB입니다. MySQL 문서는 DB 전용 서버라면 버퍼 풀에 물리 메모리의 80%까지 주는 경우가 흔하다고 하고, PostgreSQL 문서는 `shared_buffers`를 메모리의 25%에서 시작하라고 합니다. PostgreSQL은 데이터 파일을 운영체제 페이지 캐시를 거쳐 읽고 쓰기 때문에, 나머지 메모리도 사실상 캐시로 씁니다.
- **페이지 일부 기록 대비:** InnoDB는 더티 페이지를 데이터 파일에 쓰기 전에 더블 라이트 버퍼에 한 번 더 씁니다([테이블 스페이스와 Double Write Buffer](/blog/innodb-tablespace-doublewrite-buffer/)). PostgreSQL은 체크포인트 뒤 처음 바뀌는 페이지를 통째로 WAL에 적어 두고, 복구할 때 그 사본에서 다시 시작합니다.
- **커넥션:** PostgreSQL은 커넥션 하나마다 운영체제 프로세스를 하나 띄웁니다. 커넥션을 만들고 유지하는 비용이 스레드보다 커서, 커넥션 풀로 수를 묶어 두는 일이 MySQL보다 더 중요합니다.

## 정리: 설계와 운영에서 달라지는 것

- **PK:** 무작위 UUID 같은 순서 없는 PK는 InnoDB에서 테이블 자체의 페이지 분할로 이어집니다. PostgreSQL에서는 PK 인덱스에만 영향이 갑니다.
- **UPDATE가 잦은 테이블:** PostgreSQL에서는 UPDATE마다 새 버전이 쌓이니, autovacuum이 따라오는지 지켜보고 `fillfactor`와 인덱스 구성을 HOT이 되도록 맞춥니다. InnoDB는 제자리 수정이라 테이블이 부풀지 않습니다.
- **오래 열린 트랜잭션:** 둘 다 피해야 합니다. PostgreSQL에서는 VACUUM이 옛 버전을 못 치워 테이블과 인덱스가 부풀고, InnoDB에서는 언두가 쌓입니다. PostgreSQL은 32비트 트랜잭션 번호가 한 바퀴 돌기 전에 오래된 행을 동결(freeze)하는 일도 VACUUM이 맡으므로, VACUUM을 막는 긴 트랜잭션이 더 위험합니다.
- **격리 수준:** 기본값이 MySQL은 REPEATABLE READ, PostgreSQL은 READ COMMITTED입니다. MySQL REPEATABLE READ는 읽고 계산해서 쓰는 흐름의 갱신 손실을 막지 않으니 `FOR UPDATE`나 낙관적 잠금이 필요합니다. PostgreSQL에서 REPEATABLE READ 이상을 쓰면 직렬화 오류(`40001`)를 받아 재시도해야 합니다.
- **범위 잠금:** MySQL은 갭 락 때문에 조회 범위 밖의 INSERT까지 기다리게 할 수 있고, 이것이 데드락으로 번지기도 합니다. PostgreSQL에는 갭 락이 없으니 "없으면 넣는다" 같은 규칙은 유니크 제약이나 SERIALIZABLE로 지켜야 합니다.

## 참고 자료

- [PostgreSQL 문서: Transaction Isolation](https://www.postgresql.org/docs/16/transaction-iso.html)
- [PostgreSQL 문서: Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html)
- [PostgreSQL 문서: Heap-Only Tuples (HOT)](https://www.postgresql.org/docs/16/storage-hot.html)
- [MySQL 문서: InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.0/en/innodb-multi-versioning.html)
- [MySQL 문서: InnoDB Locking](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking.html)
- [MySQL 문서: Undo Tablespaces](https://dev.mysql.com/doc/refman/8.0/en/innodb-undo-tablespaces.html)
