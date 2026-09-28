---
title: 'InnoDB와 PostgreSQL 인덱스 비교: PK를 가리키느냐, 행 위치를 가리키느냐'
description: '두 DB 모두 기본 인덱스는 B-Tree인데, 같은 인덱스를 걸어도 크기와 읽는 페이지 수가 크게 다릅니다. PK 선택, 커버링 인덱스, 범위 스캔, 인덱스 종류가 두 DB에서 어떻게 갈리는지 같은 데이터로 재 봅니다.'
pubDate: '2026-09-27T18:00:00+09:00'
tags: ['mysql', 'postgresql', 'innodb', 'index', 'database', 'performance']
draft: true
---

[앞 글](/blog/innodb-vs-postgresql/)에서 InnoDB 테이블은 PK 순서로 정렬된 B-Tree(클러스터드 인덱스)이고, PostgreSQL 테이블은 순서 없는 힙이라는 차이를 봤습니다.
이 차이는 인덱스에서 더 크게 드러납니다. 두 DB 모두 기본 인덱스는 B-Tree지만, 인덱스 리프가 가리키는 대상이 다릅니다.

- **InnoDB 보조 인덱스:** 리프에 (인덱스 키, PK 값)이 들어 있습니다. 행을 읽으려면 그 PK로 클러스터드 인덱스를 한 번 더 탑니다.
- **PostgreSQL 인덱스:** 리프에 (인덱스 키, 행 위치 `ctid`)가 들어 있습니다. PK 인덱스도 똑같습니다. PostgreSQL 문서의 표현으로는 "모든 인덱스가 보조 인덱스"입니다.

이 글은 이 차이가 인덱스 크기, 커버링 인덱스, 범위 스캔, 쓸 수 있는 인덱스 종류에서 어떻게 드러나는지 같은 데이터로 확인한 기록입니다.

결과를 먼저 요약하면 이렇습니다.

- **PK가 인덱스 크기에 미치는 범위:** InnoDB에서는 PK가 모든 보조 인덱스에 들어가, PK를 36자 UUID로 바꾸자 보조 인덱스가 37.6MB에서 73.8MB로 두 배가 됐습니다. 무작위 순서로 들어오는 PK는 테이블 자체도 84.6MB에서 146.8MB로 키웠습니다. PostgreSQL 보조 인덱스는 PK가 무엇이든 34.4MB였고, 무작위 PK는 PK 인덱스만 21.4MB에서 34.5MB로 키웠습니다.
- **커버링 인덱스:** InnoDB 보조 인덱스는 PK를 품고 있어 `SELECT id, k`가 인덱스만 읽고 끝났습니다(16페이지). PostgreSQL은 필요한 컬럼이 인덱스에 다 있어도, VACUUM이 가시성 맵을 채우기 전에는 테이블을 함께 읽었습니다(VACUUM 전 1,005페이지, 후 6페이지).
- **범위 스캔:** InnoDB에서 PK 범위 1만 행은 삽입 순서와 상관없이 89~118페이지였습니다. PostgreSQL은 PK 순서대로 넣은 테이블이면 148페이지, 무작위 순서로 넣었으면 9,347페이지였습니다. 반대로 보조 인덱스로 1만 행을 읽으면 InnoDB는 행마다 클러스터드 인덱스를 타느라 44,522페이지를 읽었습니다.
- **인덱스 종류:** PostgreSQL은 B-Tree 외에 Hash, GiST, SP-GiST, GIN, BRIN이 있고 부분 인덱스와 `INCLUDE`를 쓸 수 있습니다. InnoDB는 `USING HASH`를 적어도 B-Tree를 만들었고, 부분 인덱스는 문법 오류였습니다.

실험은 Docker로 띄운 MySQL 8.0.46과 PostgreSQL 16.14에서 기본 설정으로 했습니다.
페이지 크기가 InnoDB는 16KB, PostgreSQL은 8KB이고 행 형식도 달라서, 크기와 페이지 수는 같은 DB 안에서만 비교합니다.

## 인덱스 리프에는 무엇이 들어 있나

id가 7인 행을 보조 인덱스 `k`로 찾는 경로를 그려 보면 이렇습니다.

```text
InnoDB
  보조 인덱스 ix_k             클러스터드 인덱스 (= 테이블)
  (k=42, id=7)  ── id=7로 ──▶  id=7 | k=42 | pad ...
                  다시 탐색

PostgreSQL
  인덱스 ix_k                  힙 (테이블)
  (k=42, (0,7)) ─────────────▶  (0,7): id=7 | k=42 | pad ...
  PK 인덱스                         ▲
  (id=7, (0,7)) ────────────────────┘
```

InnoDB의 보조 인덱스는 행 위치를 모릅니다. 행 위치는 페이지 분할 때마다 바뀌니, 바뀌지 않는 PK 값을 들고 있다가 클러스터드 인덱스에서 다시 찾습니다.
PK가 없는 테이블이면 InnoDB는 NULL이 없는 첫 유니크 인덱스를 클러스터드 인덱스로 쓰고, 그것도 없으면 숨은 행 ID로 클러스터드 인덱스를 만듭니다. PK 없이 만든 테이블의 인덱스 통계를 보면 그 이름이 보입니다.

```text
+-----------------+--------------+------------+
| index_name      | stat_name    | stat_value |
+-----------------+--------------+------------+
| GEN_CLUST_INDEX | n_diff_pfx01 |          1 |
+-----------------+--------------+------------+
```

PostgreSQL 인덱스는 행 위치를 직접 가리킵니다. `pageinspect`로 PK 인덱스 리프를 열어 보면 키 값마다 `ctid`가 붙어 있고, 그 `ctid`가 테이블의 행 위치와 같습니다. `data` 열은 id 1, 2, 3을 8바이트 리틀 엔디언으로 적은 값입니다.

```text
 itemoffset | ctid  |          data
------------+-------+-------------------------
          2 | (0,1) | 01 00 00 00 00 00 00 00
          3 | (0,2) | 02 00 00 00 00 00 00 00
          4 | (0,3) | 03 00 00 00 00 00 00 00
```

PostgreSQL에서 행이 UPDATE로 다른 자리로 옮겨 가면 인덱스도 새 위치를 가리키는 항목을 받아야 합니다. 이 비용과 이를 줄이는 HOT 업데이트는 [앞 글](/blog/innodb-vs-postgresql/)에서 다뤘습니다.

## PK 종류가 인덱스 크기를 바꾸는 범위

같은 100만 행을 PK만 바꿔 세 테이블에 넣었습니다. 모든 테이블에 같은 보조 인덱스 `ix_k`를 걸었고, `k` 값은 세 테이블이 똑같습니다.

```sql
CREATE TABLE a_seq (id bigint PRIMARY KEY, k int NOT NULL, pad char(50) NOT NULL DEFAULT 'x');
-- b_rand: id bigint, 겹치지 않는 값을 무작위 순서로 삽입
-- c_uuid: MySQL은 id char(36)에 무작위 UUID 문자열, PostgreSQL은 id uuid에 gen_random_uuid()
CREATE INDEX ix_k ON a_seq (k);
```

| 테이블 (PK) | InnoDB 클러스터드 인덱스 (= 테이블) | InnoDB `ix_k` | PostgreSQL 테이블 | PostgreSQL PK 인덱스 | PostgreSQL `ix_k` |
| --- | --- | --- | --- | --- | --- |
| a_seq (순차 bigint) | 84.6MB | 37.6MB | 88.8MB | 21.4MB | 34.4MB |
| b_rand (무작위 순서 bigint) | 146.8MB | 37.6MB | 88.8MB | 34.5MB | 34.4MB |
| c_uuid (무작위 UUID) | 186.0MB | 73.8MB | 96.5MB | 37.4MB | 34.4MB |

InnoDB에서는 PK가 두 곳에 영향을 줬습니다.

- **보조 인덱스:** 모든 보조 인덱스 항목에 PK가 붙으니, 8바이트 bigint를 36자 문자열로 바꾸자 `ix_k`가 두 배가 됐습니다. MySQL 문서도 "PK가 길면 보조 인덱스가 공간을 더 쓰니 짧은 PK가 유리하다"고 적고 있습니다. 보조 인덱스가 다섯 개면 다섯 개 모두 커집니다.
- **테이블 자체:** PK 순서로 정렬된 트리에 값이 무작위 순서로 들어오면, 가득 찬 페이지 한가운데에 끼어들면서 페이지가 반씩 나뉩니다. 같은 bigint인데도 무작위 순서로 넣은 b_rand는 테이블이 1.7배 컸습니다. 순서대로 들어오면 늘 오른쪽 끝 페이지만 채우니 이런 분할이 없습니다.

PostgreSQL에서는 보조 인덱스 `ix_k`가 세 테이블 모두 34.4MB였습니다. 인덱스에 붙는 것은 PK가 아니라 6바이트짜리 행 위치라서, PK가 무엇이든 상관이 없습니다.
테이블도 삽입 순서대로 뒤에 쌓을 뿐이라 PK 순서의 영향을 받지 않습니다(c_uuid가 조금 큰 것은 uuid 컬럼이 bigint보다 8바이트 넓어서입니다).
무작위 순서의 영향은 PK 인덱스에만 갔습니다. 리프 페이지 채움률이 순차 PK는 90.1%, 무작위 bigint는 56.2%여서 크기가 21.4MB에서 34.5MB가 됐습니다.

그래서 InnoDB에서는 PK를 짧고 증가하는 값으로 두는 것이 테이블과 모든 보조 인덱스의 크기를 함께 줄이는 일입니다. UUID가 필요하다면 문자열 대신 `BINARY(16)`으로 저장하고, UUIDv7처럼 시간순으로 증가하는 값을 쓰거나 `UUID_TO_BIN(uuid, 1)`로 MySQL `UUID()`의 시간 부분을 앞으로 옮겨 순서를 맞추는 방법이 있습니다.
PostgreSQL에서는 무작위 UUID PK의 비용이 PK 인덱스 하나에 그칩니다.

## 커버링 인덱스: 인덱스만 읽고 끝낼 수 있나

조회에 필요한 컬럼이 인덱스에 모두 있으면 테이블을 읽지 않고 인덱스만으로 답할 수 있습니다. 이런 인덱스를 커버링 인덱스라고 합니다. 두 DB 모두 이 최적화가 있지만 되는 조건이 다릅니다.

### InnoDB: PK는 공짜로 따라온다

InnoDB 보조 인덱스에는 PK가 이미 들어 있으니, 인덱스 컬럼과 PK만 읽는 조회는 따로 설정하지 않아도 커버링이 됩니다. `k` 범위로 1,000행을 읽으며 페이지를 몇 번 읽었는지(`Innodb_buffer_pool_read_requests` 증가량) 비교했습니다.

| 조회 | `EXPLAIN`의 Extra | 페이지 읽기 |
| --- | --- | --- |
| `SELECT id, k FROM a_seq WHERE k BETWEEN 100000 AND 100999` | Using where; Using index | 16 |
| `SELECT id, k, pad FROM a_seq WHERE k BETWEEN 100000 AND 100999` | Using index condition | 4,013 |

`pad`가 하나 더 붙자 1,000행마다 클러스터드 인덱스를 다시 타면서 페이지 읽기가 250배가 됐습니다. InnoDB에서 보조 인덱스를 쓰는 조회가 느리다면, 자주 읽는 컬럼을 인덱스 키에 더해 커버링으로 만드는 것이 가장 효과가 큽니다.

### PostgreSQL: VACUUM이 가시성 맵을 채워야 한다

PostgreSQL 인덱스에는 행이 지금 트랜잭션에게 보이는지에 대한 정보가 없습니다. 옛 버전과 새 버전이 모두 인덱스 항목을 가질 수 있어서, 원래는 힙에 가서 `xmin`/`xmax`를 봐야 합니다.
이를 건너뛰게 해 주는 것이 가시성 맵(visibility map)입니다. 페이지마다 "이 페이지의 행은 모든 트랜잭션에게 보인다"는 비트를 두고, 인덱스만 읽는 스캔은 이 비트가 켜진 페이지에 대해서만 힙 방문을 생략합니다. 이 비트를 켜는 것이 VACUUM입니다.

autovacuum이 끼어들지 않도록 꺼 둔 테이블에 100만 행을 넣고, 같은 1,000행 범위를 읽었습니다.

| 순서 | 조회와 상태 | 실행 계획 | 페이지 읽기 |
| --- | --- | --- | --- |
| 1 | `SELECT k`, VACUUM 전 | Bitmap Heap Scan | 1,005 |
| 2 | `SELECT k`, VACUUM 후 | Index Only Scan, Heap Fetches: 0 | 6 |
| 3 | `SELECT id, k` (`id`는 인덱스에 없음) | Bitmap Heap Scan | 1,005 |
| 4 | `SELECT id, k`, `(k) INCLUDE (id)` 인덱스 추가 | Index Only Scan, Heap Fetches: 0 | 7 |
| 5 | 4번 상태에서 그중 200행을 UPDATE한 뒤 | Index Only Scan, Heap Fetches: 400 | 408 |

1번에서는 필요한 `k`가 인덱스에 다 있는데도 인덱스만 읽는 스캔을 고르지 않았습니다. 가시성 맵이 비어 있으면 어차피 모든 행을 힙에서 확인해야 하니 이득이 없기 때문입니다. VACUUM 뒤에는 같은 조회가 6페이지로 끝났습니다.

3번은 PostgreSQL 인덱스가 PK를 품고 있지 않다는 점을 보여 줍니다. InnoDB라면 커버링이었을 `SELECT id, k`가 여기서는 힙을 읽습니다. 키가 아닌 컬럼을 인덱스 리프에 얹는 `INCLUDE`(PostgreSQL 11부터)를 쓰자 4번처럼 인덱스만으로 끝났습니다.

5번은 UPDATE가 이 최적화를 얼마나 쉽게 깨는지 보여 줍니다. 고친 200행은 옛 버전과 새 버전이 모두 인덱스 항목을 갖고, 둘 다 비트가 꺼진 페이지에 있어 힙을 400번 확인했습니다. 다음 VACUUM이 비트를 다시 켤 때까지 이 상태가 이어집니다.

InnoDB에도 비슷한 확인이 있습니다. 보조 인덱스 페이지마다 그 페이지를 마지막으로 바꾼 트랜잭션 번호를 들고 있다가, 읽는 트랜잭션의 스냅숏보다 최근에 바뀐 페이지만 클러스터드 인덱스로 확인하러 갑니다. 다만 이 정보를 페이지가 바뀔 때 바로 기록하므로 VACUUM 같은 별도 작업을 기다리지 않습니다.

## 범위 스캔: 행이 물리적으로 모여 있는가

범위 조회의 비용은 결국 조건에 맞는 행이 몇 페이지에 흩어져 있느냐로 정해집니다. 앞의 a_seq(PK 순서대로 삽입)와 b_rand(무작위 순서로 삽입)에서 1만 행을 읽는 범위 조회를 했습니다. `max(pad)`로 행 데이터까지 읽게 했습니다.

```sql
SELECT max(pad) FROM a_seq  WHERE id BETWEEN 500000 AND 509999;              -- PK 범위
SELECT max(pad) FROM b_rand WHERE id BETWEEN 2000000000 AND 2042949672;      -- PK 범위, 1만 행
SELECT max(pad) FROM a_seq  WHERE k  BETWEEN 500000 AND 509999;              -- 보조 인덱스 범위
```

| 조회 (각 1만 행) | InnoDB 페이지 읽기 | PostgreSQL 페이지 읽기 |
| --- | --- | --- |
| PK 범위, PK 순서대로 넣은 테이블 | 89 | 148 |
| PK 범위, 무작위 순서로 넣은 테이블 | 118 | 9,347 |
| 보조 인덱스 `k` 범위 | 44,522 | 9,024 |

두 DB는 페이지 크기와 세는 방식이 달라서 가로로 비교하면 안 됩니다. 각 열을 위아래로 읽어 주세요.

**InnoDB의 PK 범위는 늘 모여 있습니다.** 테이블 자체가 PK 순서로 정렬된 트리라서, PK 범위 조회는 이어진 리프 페이지를 차례로 읽으면 끝납니다. 무작위 순서로 넣은 b_rand도 118페이지였습니다. 페이지가 덜 차 있어 조금 더 읽었을 뿐입니다.

**PostgreSQL의 PK 범위는 삽입 순서에 달려 있습니다.** PK 인덱스는 정렬돼 있어도 가리키는 행은 힙에 넣은 순서대로 놓여 있습니다. PostgreSQL은 이 관계를 컬럼별 `correlation` 통계로 들고 있습니다.

```text
 tablename | attname | correlation
-----------+---------+-------------
 a_seq     | id      |       1.000
 a_seq     | k       |       0.002
 b_rand    | id      |      -0.003
```

a_seq의 `id`처럼 1에 가까우면 인덱스 순서와 힙 순서가 같아서 148페이지로 끝났습니다. b_rand의 `id`처럼 0에 가까우면 1만 행이 힙 페이지 9,298개에 흩어져 있었고, 플래너는 행 위치를 페이지 순으로 모아 한 번씩 읽는 Bitmap Heap Scan으로 바꿨습니다.
`CLUSTER` 명령으로 테이블을 인덱스 순서로 다시 쓸 수는 있지만 한 번 정렬할 뿐이고, 이후 들어오는 행은 다시 순서 없이 쌓입니다.

**보조 인덱스 범위에서는 InnoDB가 더 많이 읽습니다.** InnoDB는 보조 인덱스에서 얻은 PK로 행마다 클러스터드 인덱스를 루트부터 다시 내려가서, 1만 행에 페이지 읽기가 44,522번(행당 4.5번꼴)이었습니다. 대부분 버퍼 풀에 있는 상위 페이지를 반복해서 읽은 것이지만, 행 수에 비례해 탐색이 늘어납니다.
PostgreSQL은 인덱스가 행 위치를 바로 알려 주고, Bitmap Heap Scan이 같은 페이지를 한 번만 읽어서 힙 페이지 8,975개에서 끝났습니다.

이 결과는 설계 방향으로 이어집니다.

- **InnoDB:** 자주 범위로 읽는 순서를 PK에 담으면 그 조회가 늘 모인 페이지를 읽습니다. 예를 들어 사용자별로 글을 자주 읽는다면 `(user_id, id)` 복합 PK로 한 사용자의 행을 모아 둘 수 있습니다. 대신 PK가 길어진 만큼 모든 보조 인덱스가 커집니다.
- **PostgreSQL:** 물리 순서는 삽입 순서입니다. `created_at`처럼 삽입 순서와 함께 증가하는 컬럼은 자연히 상관도가 높고, 뒤에서 볼 BRIN 인덱스가 이 성질을 이용합니다.

## 인덱스 종류와 기능

InnoDB는 B-Tree가 거의 전부이고, PostgreSQL은 데이터 모양에 맞춰 고를 수 있는 인덱스 방식이 여럿입니다.

| 기능 | InnoDB | PostgreSQL |
| --- | --- | --- |
| B-Tree | 기본 | 기본 |
| Hash | 없음 (내부의 어댑티브 해시 인덱스만 자동으로 생김) | 있음 |
| 전문 검색 | FULLTEXT (역인덱스) | GIN + `tsvector` |
| 공간 데이터 | SPATIAL (R-Tree) | GiST, SP-GiST |
| 배열·JSON 원소 | 다중 값 인덱스 (8.0.17부터) | GIN |
| 블록 범위 요약 | 없음 | BRIN |
| 부분 인덱스 (`WHERE`) | 없음 | 있음 |
| 표현식 인덱스 | 함수 키 파트 (8.0.13부터) | 있음 |
| 문자열 앞부분만 인덱스 | 접두사 인덱스 `col(10)` | 없음 (표현식 인덱스로 대신) |
| 키 아닌 컬럼 포함 (`INCLUDE`) | 없음 (PK는 자동 포함) | 있음 |
| 같은 키 중복 제거 | 없음 | 있음 (13부터) |
| 옵티마이저에서 숨기기 | INVISIBLE 인덱스 | 없음 |

몇 가지는 직접 확인했습니다.

**InnoDB에 `USING HASH`를 적으면** 오류 없이 B-Tree가 만들어집니다. 경고 하나만 남습니다.

```text
Note 3502: This storage engine does not support the HASH index algorithm, storage engine default was used instead.

+------------+------------+
| INDEX_NAME | INDEX_TYPE |
+------------+------------+
| ix_hash    | BTREE      |
+------------+------------+
```

InnoDB의 해시 인덱스는 [어댑티브 해시 인덱스](/blog/innodb-adaptive-hash-index/)처럼 엔진이 자주 읽는 페이지에 대해 알아서 만드는 것뿐입니다.

**부분 인덱스**는 조건에 맞는 행만 인덱스에 넣습니다. 100만 건 중 1%만 `PENDING`인 작업 테이블에서, 처리할 작업만 찾는 인덱스를 비교했습니다.

| 인덱스 | 크기 |
| --- | --- |
| `CREATE INDEX ON job (status)` | 6.63MB |
| `CREATE INDEX ON job (status) WHERE status = 'PENDING'` | 0.09MB |

같은 문장을 MySQL에서 실행하면 `ERROR 1064`(문법 오류)가 납니다. MySQL에서는 보통 상태 컬럼을 앞에 둔 복합 인덱스로 대신하는데, 그러면 `DONE`인 99%의 행도 인덱스에 들어갑니다.

**중복 제거**는 PostgreSQL 13부터 B-Tree에 들어간 기능으로, 같은 키가 반복되면 키를 한 번만 적고 행 위치를 목록으로 붙입니다. 값이 10가지뿐인 컬럼에 인덱스를 걸어 이 기능을 끄고 켜 봤습니다.

| 인덱스 (100만 행, 서로 다른 값 10개) | 크기 |
| --- | --- |
| 중복 제거 켬 (기본값) | 6.64MB |
| 중복 제거 끔 (`deduplicate_items = off`) | 21.48MB |

InnoDB 보조 인덱스는 항목마다 PK가 붙어 모든 항목이 서로 다르므로, 이런 중복 제거가 없습니다.

**BRIN**은 페이지 묶음마다 최솟값과 최댓값만 적어 두는 인덱스입니다. 로그나 이벤트처럼 시간순으로 쌓이는 테이블에서 시간 컬럼에 걸면 B-Tree보다 훨씬 작은 인덱스로 범위 조회를 거를 수 있습니다. 앞 절의 `correlation`이 1에 가까운 컬럼일수록 잘 듣습니다.

## 정리: 설계에서 달라지는 것

- **PK:** InnoDB에서 PK는 테이블의 물리 순서이자 모든 보조 인덱스에 붙는 값입니다. 짧고 증가하는 값으로 두고, UUID가 필요하면 `BINARY(16)`에 시간순 값을 씁니다. PostgreSQL에서 PK는 유일 인덱스 하나일 뿐이라 무작위 UUID의 비용이 PK 인덱스에 그칩니다.
- **범위 조회:** InnoDB는 PK 범위가 늘 모여 있으니 자주 범위로 읽는 순서를 PK에 담을 수 있습니다. PostgreSQL은 물리 순서가 삽입 순서라서, 삽입 순서와 무관한 컬럼의 범위 조회는 흩어진 페이지를 읽습니다.
- **커버링 인덱스:** InnoDB는 PK가 자동으로 포함되고, 보조 인덱스 조회가 행마다 클러스터드 인덱스를 다시 타니 커버링의 효과가 큽니다. PostgreSQL은 `INCLUDE`로 컬럼을 얹을 수 있지만, VACUUM이 가시성 맵을 채워 둬야 인덱스만 읽을 수 있습니다. 쓰기가 잦은 테이블에서 인덱스만 읽는 스캔을 기대한다면 autovacuum이 충분히 자주 도는지도 봐야 합니다.
- **인덱스 종류:** PostgreSQL은 부분 인덱스, GIN, BRIN 등으로 데이터 모양에 맞출 여지가 큽니다. InnoDB는 B-Tree 하나로 설계하되, PK와 복합 인덱스 순서를 더 신경 써야 합니다.

## 참고 자료

- [MySQL 문서: Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html)
- [MySQL 문서: CREATE INDEX Statement](https://dev.mysql.com/doc/refman/8.0/en/create-index.html)
- [PostgreSQL 문서: Index-Only Scans and Covering Indexes](https://www.postgresql.org/docs/16/indexes-index-only-scans.html)
- [PostgreSQL 문서: Index Types](https://www.postgresql.org/docs/16/indexes-types.html)
- [PostgreSQL 문서: Partial Indexes](https://www.postgresql.org/docs/16/indexes-partial.html)
- [PostgreSQL 문서: B-Tree Implementation (Deduplication)](https://www.postgresql.org/docs/16/btree-implementation.html)
