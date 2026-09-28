---
title: 'MySQL 의 잠금 : InnoDB 스토리지 엔진 잠금'
description: 'InnoDB 스토리지 엔진 잠금 정리 : 레코드 락, 갭 락, 넥스트 키 락, 자동 증가 락'
pubDate: '2023-08-12'
tags: ['mysql', 'innodb', 'lock', 'concurrency', 'database', 'real-mysql']
series:
  id: real-mysql
  order: 9
  label: 'InnoDB 스토리지 엔진 잠금'
---

## 들어가며

<img src="/images/innodb-storage-engine-lock/01.png" alt="자물쇠와 열쇠 아이콘 옆에 놓인 MySQL 로고" width="620" height="272" loading="lazy" decoding="async" style="max-width: 354px" />

이번 글에서는 MySQL에서 사용되는 잠금(Lock) 중에서 **InnoDB 스토리지 엔진 레벨의 잠금**에 대해 살펴보려고 한다.

InnoDB 스토리지 엔진은 MySQL 에서 제공하는 잠금과는 별개로, 스토리지 엔진 내부에서 `레코드 기반의 잠금 방식을 탑재`하고 있다. 이 레코드 기반의 잠금 방식 때문에 MyISAM 보다 훨씬 뛰어난 동시성 처리를 제공할 수 있다.

이원화된 잠금 처리 탓에 InnoDB 스토리지 엔진에서 사용되는 잠금에 대한 정보는 MySQL 명령을 이용해 접근하기 까다로웠다. 하지만, 최근 버전에서 InnoDB 의 트랜잭션과 잠금, 그리고 잠금 대기 중인 트랜잭션의 목록을 조회할 수 있는 방법이 도입되었다.

MySQL 서버의 `information_schema` 데이터베이스에 존재하는 `INNODB_TRX`, `INNODB_LOCKS`, `INNODB_LOCK_WAITS` 라는 테이블들을 조인해서 조회하면

- **현재 어떤 트랜잭션이 어떤 잠금을 대기**하고 있고, **해당 잠금을 어느 트랜잭션이 가지고 있는지** 확인할 수 있으며
- 장시간 잠금을 가지고 있는 클라이언트를 찾아서 종료시킬 수도 있다

Performance Schema 를 이용해 InnoDB 스토리지 엔진의 내부 잠금(세마포어)에 대한 모니터링도 할 수 있다.

## InnoDB 스토리지 엔진의 잠금

- InnoDB 스토리지 엔진은 레코드 기반의 잠금 기능을 제공한다.
- 락이 레벨업되는 `락 에스컬레이션`이 없다
  - 잠금 정보가 상당히 작은 공간으로 관리되기 때문
  - 락 에스컬레이션(`레코드 락` → `페이지 락` or `테이블 락`)

### 1. 레코드 락 (Record lock,  Record only lock)

> **`레코드 자체만을 잠그는 것`을 레코드 락이라고 한다.**
>
> **다만 중요한 점은, InnoDB 스토리지 엔진은 `레코드 자체`가 아니라, `인덱스의 레코드`를 잠근다.**

인덱스가 하나도 없는 테이블이더라도 내부적으로 자동 생성된 클러스터 인덱스를 이용해 잠금을 설정한다.

레코드 자체를 잠그느냐, 인덱스를 잠그느냐 하는 것은 상당히 중요한 차이를 만들어낸다.

InnoDB 에서는 대부분

- `보조 인덱스(세컨더리 인덱스)`를 이용한 변경 작업은
  - **갭 락(Gap lock**) 또는 <strong>넥스트 키 락(Next key lock)</strong>을 사용하지만,
- `프라이머리 키` 또는 `유니크 인덱스`에 의한 변경 작업에서는
  - 갭(Gap, 간격)에 대해서 잠그지 않고 **레코드 자체에 대해서만 락을 건다**.

### 2. 갭 락 (Gap lock)

다음은 [InnoDB 갭 락](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html#innodb-gap-locks)의 주요 내용이다.

1. 갭 락(Gap Lock)은 `인덱스 레코드 사이의 간격에 대한 락`이거나, `첫 번째 또는 마지막 인덱스 레코드 앞이나 뒤의 간격에 대한 락`이다.
   - 열에 이미 값이 존재하든 존재하지 않든 상관없이, 해당 범위 안의 모든 기존 값 사이의 간격이 잠긴다.
2. 갭은 단일 인덱스 값, 여러 인덱스 값 또는 비어 있는 공간을 포함할 수 있다.
3. 갭 락은 **성능**과 **동시성** 사이에서 tradeoff 대상이다
   - `REPEATABLE READ`, `SERIALIZABLE` 격리 수준에서 사용되고,
   - `READ COMMITTED`, `READ UNCOMMITTED`에서는 사용되지 않는다
4. primary key, unique index 를 사용하여 unique row 를 검색하는 문장에서는 갭 락이 필요없다.
   - 즉, 쿼리의 조건이 1건의 결과를 보장하는 경우, 갭 락은 사용되지 않고 레코드 락만 사용된다
   - 다른 세션이 이전 간격에 행을 삽입하는지 여부는 상관없다
   - multiple-column 인덱스의 일부 column 만을 포함하는 검색 조건인 경우, 갭 락이 발생한다
   - 쿼리의 조건이 1건의 결과를 보장하지 못하는 경우, 이전 간격을 잠근다. 즉, 갭 락과 레코드 락이 함께 사용된다.
5. 갭 락은 서로 다른 트랜잭션이 공유할 수 있다.
   - 예를 들어, 트랜잭션 A는 특정 간격에 대해 공유 갭 락(gap S-lock)을 가지는 동안,
   - 트랜잭션 B는 동일한 간격에 대해 배타적 갭 락(gap X-lock)을 가질 수 있다.
   - 갭 락을 서로 다른 트랜잭션이 공유할 수 있는 이유는 인덱스에서 레코드가 제거될 경우, 다른 트랜잭션에 의해 해당 레코드에 대해 유지되는 갭 락을 병합해야 하기 때문이다.
6. 갭 락은 트랜잭션 격리 수준을 `READ COMMITTED`로 변경하면 명시적으로 비활성화할 수 있다.
   - 이 경우, 갭 락은 **검색 및 인덱스 스캔에 대해 비활성화**되며
   - **외래 키 제약 조건 검사 및 중복 키 검사에만 사용**된다
7. READ COMMITTED 격리 수준을 사용할 때의 다른 효과
   - 조건에 맞지 않는 행에 대한 레코드 락은 MySQL이 WHERE 조건을 평가한 후 잠금이 해제된다.
   - UPDATE 문장의 경우, InnoDB는 "반 일관된" 읽기를 수행해 MySQL에 latest committed 버전을 반환하여, MySQL이 해당 행이 UPDATE 문의 WHERE 조건에 맞는지 여부를 결정할 수 있도록 한다.

> **InnoDB 갭 락의 유일한 목적은 `다른 트랜잭션이 레코드와 레코드 사이의 간격에 새로운 레코드가 생성(INSERT)되는 것을 방지하는 것`이다.**
>
> 갭 락은 그 자체보다, `넥스트 키 락의 일부로 자주 사용`된다.

### 3. 넥스트 키 락 (Next Key lock)

> **`레코드 락(Record lock)` + `갭 락(Gap lock)` = `넥스트 키 락(Next key lock)`**

- STATEMENT 포맷의 바이너리 로그를 사용하는 MySQL 서버에서는 REPEATABLE READ 격리 수준을 사용해야 한다.
- 또한 `innodb_locks_unsafe_for_binlog` 시스템 변수가 비활성화되면(0으로 설정되면) 변경을 위해 검색하는 레코드에는 넥스트 키 락 방식으로 잠금이 걸린다.
- InnoDB 의 갭 락이나 넥스트 키 락은 “**바이너리 로그에 기록되는 쿼리가 레플리카 서버에서 실행될 때, 소스 서버에서 만들어낸 결과와 동일한 결과를 만들어내도록 보장하는 것**”이 주 목적이다.
- 그런데 의외로 넥스트 키 락과 갭 락으로 인해 데드락이 발생하거나 다른 트랜잭션을 기다리게 만드는 일이 자주 발생한다.
- **가능하다면 바이너리 로그 포맷을 ROW 형태로 바꿔서 넥스트 키 락이나 갭 락을 줄이는 것이 좋다.**

> 🌀 **넥스트 키 락 이해를 위한 예제**
>
> <img src="/images/innodb-storage-engine-lock/02.png" alt="primary_key 인덱스 15, 25, 35, 45, 55 중 20 &lt; primary_key &lt; 50 조건에 걸리는 25, 35, 45에는 레코드 락이, 25·35·45·55 앞의 간격에는 갭 락이 걸린 모습" width="1738" height="1194" loading="lazy" decoding="async" style="max-width: 576px" />
>
> `tableA` 테이블의 컬럼 **primary_key** 에 인덱스가 걸려있는 상황이다.
>
> ```sql
> SELECT * FROM tableA
> WHERE primary_key > 20 AND primary_key < 50
> FOR UPDATE;
> ```
>
> - `SELECT ... FOR UPDATE` 문을 사용하면 조회하는 레코드에 대해 `X락(배타락)`을 건다.
> - **index range 스캔**을 통해 `20 < primary_key < 50` 조건을 만족하는 **인덱스에 대해**<br>
>   **record lock** 을 건다
> - 25 index record 이전 범위 `25 > primary_key` 에 Gap Lock 이 걸린다
>   - 25 index record 에는 Record Lock 이 걸린다
> - 35 index record 이전 범위 `35 > primary_key > 25` 에 Gap Lock 이 걸린다
>   - 35 index record 에는 Record Lock 이 걸린다
> - 45 index record 이전 범위 `45 > primary_key > 35` 에 Gap Lock 이 걸린다
>   - 45 index record 에는 Record Lock 이 걸린다
> - 55 index record 이전 범위 `55 > primary_key > 45` 에 Gap Lock 이 걸린다
>
> **위와 같이 `record lock` 과 `gap lock` 이 복합적으로 적용되는 것을 `next key lock` 이라 한다.**

### 4. 자동 증가 락 (Auto increment lock)

> MySQL 에서는 자동 증가하는 숫자 값을 추출(채번)하기 위해 `AUTO_INCREMENT` 라는 칼럼 속성을 제공한다. `AUTO_INCREMENT` 칼럼이 사용된 테이블에 동시에 여러 레코드가 INSERT 되는 경우, 저장되는 각 레코드는 중복되지 않고 저장된 순서대로 증가하는 일련번호 값을 가져야한다. InnoDB 스토리지 엔진에서는 이를 위해 내부적으로 **`AUTO_INCREMENT 락(Auto increment lock)`이라고 하는 테이블 수준의 잠금을 사용**한다.

> **AUTO_INCREMENT 락(Auto increment lock) 의 특징 (feat.MySQL 5.0 이하 버전)**

- `새로운 레코드를 저장하는 쿼리에서만 필요`하다.
  - `INSERT` 와 `REPLACE` 쿼리 문장에서 걸린다
  - `UPDATE` 나 `DELETE` 등의 쿼리에서는 걸리지 않는다.
- `트랜잭션과 관계없이` INSERT 나 REPLACE 문장에서 AUTO_INCREMENT 값을 가져오는 순간만 락이 걸렸다가 즉시 해제된다.
- AUTO_INCREMENT 락은 `테이블에 단 하나만 존재`한다.
  - 두 개의 INSERT 쿼리가 동시에 실행되는 경우, 하나의 쿼리가 AUTO_INCREMENT 락을 걸면 나머지 쿼리는 AUTO_INCREMENT 락을 기다려야 한다.
- 락을 명시적으로 획득하고 해제하는 방법이 없다
  - 아주 짧은 시간동안 걸렸다가 해제되는 잠금이라 대부분의 경우 문제가 되지 않는다

> **자동 증가 락의 작동 방식 변경 (feat.MySQL 5.1 이상 버전)**

MySQL 5.1 이상부터는 `innodb_autoinc_lock_mode` 라는 시스템 변수를 통해 자동 증가 락의 작동 방식을 변경할 수 있다.

- `innodb_autoinc_lock_mode = 0`
  - MySQL 5.0 과 동일한 잠금 방식으로, 모든 INSERT 문장은 자동 증가 락을 사용한다

- `innodb_autoinc_lock_mode = 1` (연속 모드, Consecutive mode)
  - **MySQL 서버가 INSERT 되는 레코드의 건수를 정확히 예측할 수 있을 때**
    - 자동 증가 락을 사용하지 않고, 훨씬 가볍고 빠른 `래치(뮤텍스)`를 이용해 처리한다
    - 래치는 자동 증가 락과 달리, 아주 짧은 시간 동안만 잠금을 걸고 필요한 자동 증가 값을 가져오면 즉시 잠금이 해제된다
  - **MySQL 서버가 INSERT 되는 레코드의 건수를 정확히 예측할 수 없을 때 (INSERT … SELECT)**
    - MySQL 5.0 에서와 같이 자동 증가 락을 사용한다
    - INSERT 문장이 완료되기 전 까지는 자동 증가 락은 해제되지 않기 때문에, 다른 커넥션에서 이를 대기한다
    - 이와 같이 대량 INSERT 가 수행될 때, InnoDB 스토리지 엔진은 `여러 개의 자동 증가 값을 한번에 할당받아`서 INSERT 되는 레코드에 사용한다
    - 만약 한 번에 할당받은 자동 증가 값이 남아서 사용되지 못하면 폐기한다.
    - 따라서 **대량 INSERT 문장 실행 이후에 INSERT 되는 레코드의 자동 증가 값**은, 연속되지 않고 누락된 값이 발생할 수 있다
    - 최소 하나의 INSERT 문장으로 INSERT 되는 레코드는 연속된 자동 증가 값을 가지게 된다.

- `innodb_autoinc_lock_mode = 2` (인터리빙 모드, Interleaved mode)
  - InnoDB 스토리지 엔진은 절대 자동 증가 락을 걸지 않고, 경량화된 래치(뮤텍스)를 사용한다
  - 하나의 INSERT 문장으로 INSERT 되는 레코드라 하더라도, 연속된 자동 증가 값을 보장하지 않는다
  - 대량 INSERT 문장이 실행되는 중에도 다른 커넥션에서 INSERT 를 수행할 수 있다. (동시성이 높다)
  - 이 모드에서 작동하는 자동 증가 기능은 `유니크한 값이 생성된다는 것만 보장`한다
  - STATEMENT 포맷의 바이너리 로그를 사용하는 복제에서는 소스 서버와 레플리카 서버의 자동 증가 값이 달라질 수 도 있으므로 주의해야한다

**`AUTO_INCREMENT` 잠금을 최소화하기 위해**서 자동 증가 값이 한 번 증가하면 절대 줄어들지 않는다. INSERT 쿼리가 실패했다 하더라도, 한 번 증가된 `AUTO_INCREMENT` 값은 다시 줄어들지 않고 그대로 남는다.

> ⚠️ **주의 : MySQL 8.0 버전에서의 innodb_autoinc_lock_mode 기본값**
>
> - MySQL 5.7 버전까지 **innodb_autoinc_lock_mode** 의 기본값은 1 이었다.
> - MySQL 8.0 버전부터 **innodb_autoinc_lock_mode** 의 기본값은 2 이다.
>
> 이는 MySQL 8.0 부터 `바이너리 로그 포맷이 STATEMENT 가 아니라` **`ROW 포맷`**`이 기본값이 됐기 때문`이다. MySQL 8.0 에서 ROW 포맷이 아니라 STATEMENT 포맷의 바이너리 로그를 사용한다면 **innodb_autoinc_lock_mode** 를 2가 아닌 1로 변경해서 사용할 것을 권장한다.

### 5. 락의 유형 (feat.`Exclusive lock`, `Shared lock`, `Intention lock`)

> **Exclusive lock (X락, 배타적 잠금, 독점 잠금) - row level locking**

- 트랜잭션에서 데이터를 변경(`UPDATE` or `DELETE`)할 때 사용하는 락이다
- row 레벨에 걸리는 락으로, 테이블의 개별 행에 잠금이 걸린다
- X락 이 걸려있으면 S락을 걸 수 없다
- X락 이 걸려있으면 X락을 걸 수 없다

> **Shared lock (S락, 공유 잠금) - row level locking**

- 트랜잭션이 데이터를 읽을 때 사용하는 락이다
- 데이터를 읽을 수 있지만, 쓰거나 변경할 수 없다
- row 레벨에 걸리는 락으로, 테이블의 개별 행에 잠금이 걸린다
- 한 트랜잭션이 특정 레코드에 대해 S락을 잡고 있는 경우, 다른 트랜잭션에서 해당 레코드의 S락을 얻을 수 있다
- S락이 걸려있는 레코드에 대해 다른 트랜잭션이 X락을 얻을 수 없다

> **Intention lock (Intention Shared lock, Intention Exclusive lock) - table level locking**

**Intention lock 은 테이블의 row에 대해 `트랜잭션이 이후에 필요한 잠금 유형(S락 or X락)을 나타내는 테이블 수준 잠금`이다.** 더 자세한 내용은 [공식문서](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html#innodb-intention-locks)를 통해 확인할 수 있다.

- **Intention Shared lock (`IS` 락)**
  - IS 락은 트랜잭션이 **테이블의 개별 row에 S락을 설정하려는 의도**를 나타낸다
- **Intention Exclusive lock (`IX` 락)**
  - IX 락은 트랜잭션이 **테이블의 개별 row에 X락을 설정하려는 의도**를 나타낸다

> **lock 간 호환성**

|  | X | S | IX | IS |
| --- | --- | --- | --- | --- |
| X | ❌ | ❌ | ❌ | ❌ |
| S | ❌ | ✅ | ❌ | ✅ |
| IX | ❌ | ❌ | ✅ | ✅ |
| IS | ❌ | ✅ | ✅ | ✅ |

## 인덱스와 잠금

> InnoDB 의 잠금은 레코드 자체를 잠그는 것이 아니라, 인덱스를 잠그는 방식으로 처리된다.
>
> **즉, 변경해야 할 레코드를 찾기 위해 `검색한 인덱스의 레코드에 모두 락을 걸어`야 한다.**

예시를 통해 조금 더 정확히 알아보자.

```sql
CREATE TABLE employees (
  id INT NOT NULL AUTO_INCREMENT,
  first_name VARCHAR(20) NOT NULL,
  last_name VARCHAR(20) NOT NULL,
  hire_date DATETIME(6) NOT NULL,
  PRIMARY KEY(id),
  INDEX ix_firstname(first_name)
);
```

- employees 테이블에는 first_name 칼럼에 대해서 INDEX 를 생성해두었다
- `first_name='Georgi'` 인 사원은 전체 253명이 있다
- `first_name='Georgi'` 이면서 `last_name='Klassen'` 인 사원은 1명만 있다

employees 테이블에서 `first_name='Georgi'` 이고 `last_name='Klassen'` 인 사원의 입사 일자를 오늘로 변경하는 쿼리를 실행한다고 하자.

```sql
UPDATE employees SET hire_date=NOW()
WHERE first_name='Georgi' AND last_name='Klassen';
```

위의 쿼리가 실행되면 최종적으로 1건의 레코드가 업데이트 될 것이다.

하지만 이 1건의 업데이트를 위해 몇 개의 레코드에 락을 걸까?

이 UPDATE 문장 조건에서 **인덱스를 이용할 수 있는 조건은 first_name='Georgi'** 이며,<br>
**last_name 칼럼은 인덱스가 없기 때문에,** `first_name='Georgi' 인 레코드 253건의 레코드가 모두 잠긴다`.

만약 UPDATE 문장을 위해 적절히 인덱스가 준비돼 있지 않다면 각 클라이언트 간의 동시성이 상당히 떨어져, 한 세션에서 UPDATE 작업을 하는 중에는 다른 클라이언트는 그 테이블을 업데이트하지 못하고 기다리는 상황이 발생할 것이다.

심지어 해당 테이블에 인덱스가 하나도 없었다면, 테이블을 풀 스캔하면서 UPDATE 작업을 한다. 이 과정에서 테이블에 있는 모든 레코드를 잠그게 된다.

## 레코드 수준의 잠금 확인 및 해제

InnoDB 스토리지 엔진을 사용하는 테이블의 레코드 수준 잠금은, 테이블 수준의 잠금보다 더 복잡하다.

레코드 수준의 잠금은 테이블의 레코드 각각에 잠금이 걸리므로, 그 레코드가 자주 사용되지 않는다면 오랜 시간 동안 잠겨진 상태로 남아 있어도 잘 발견되지 않는다.

| 커넥션 1 | 커넥션 2 | 커넥션 3 |
| --- | --- | --- |
| `BEGIN`; |  |  |
| `UPDATE` employees<br>`SET` birth_date=NOW()<br>`WHERE` emp_no=1; |  |  |
|  | `UPDATE` employees<br>`SET` hire_date=NOW()<br>`WHERE` emp_no=1; |  |
|  |  | `UPDATE` employees<br>`SET` birth_date=NOW(), hire_date=NOW()<br>`WHERE` emp_no=1; |

MySQL 8.0 부터는 `performance_schema` 의 `data_locks` 와 `data_lock_waits` 테이블을 통해, 각 트랜잭션이 어떤 잠금을 기다리고 있는지, 기다리고 있는 잠금은 어떤 트랜잭션이 가지고 있는지 등의 메타 정보를 확인할 수 있다.

> **잠금 대기 순서 조회하기**

```sql
SELECT
  r.trx_id AS waiting_trx_id,
  r.trx_mysql_thread_id AS waiting_thread,
  r.trx_query AS waiting_query,
  b.trx_id AS blocking_trx_id,
  b.trx_mysql_thread_id AS blocking_thread,
  b.trx_query AS blocking_query,
FROM performance_schema.data_lock_waits AS w
INNER JOIN information_schema.innodb_trx AS b
  ON b.trx_id = w.blocking_engine_transaction_id
INNER JOIN information_schema.innodb_trx r
  ON r.trx_id = w.requesting_engine_transaction_id;
```

> **스레드가 가진 잠금 확인하기**

```sql
SELECT * FROM performance_schema.data_locks;
```

> **스레드 강제 종료**

```sql
KILL 17; -- KILL {스레드_번호}
```
