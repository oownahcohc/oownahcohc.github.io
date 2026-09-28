---
title: 'InnoDB 에서 INSERT 시 잠금 메커니즘 맛보기'
description: 'InnoDB에서 INSERT 실행 시 X락의 사용에 대해 (feat.암묵적 잠금과 명시적 잠금 메커니즘)'
pubDate: '2024-06-30'
tags: ['mysql', 'innodb', 'lock', 'concurrency', 'database']
---

## 들어가며

> 이 글에서 다루고자 하는 궁금증은 다음과 같다.
>
> 1. **INSERT 문 실행 시 InnoDB 는 X락을 사용하는가**
> 2. **사용한다면 왜 performance_schema.data_locks 테이블에서 바로 조회되지 않는가**
> 3. **LOCK_MODE 를 어떻게 해석해야 하는가**

## 1. INSERT 시 X 락을 사용하는가?

[**InnoDB 스토리지 엔진 잠금**](/blog/innodb-storage-engine-lock/)을 공부하면서 한 가지 의문이 들었다.

> A [shared (`S`) lock](https://dev.mysql.com/doc/refman/8.4/en/glossary.html#glos_shared_lock) permits the transaction that holds the lock to read a row.
>
> An [exclusive (`X`) lock](https://dev.mysql.com/doc/refman/8.4/en/glossary.html#glos_exclusive_lock) permits the transaction that holds the lock to `update` or `delete` a row.

exclusive(X) lock 은 트랜잭션이 테이블의 row 에 대해 UPDATE 나 DELETE 시, 해당 row 를 잠그는 방식으로 동작한다고 공식문서에 언급되어 있다.

지금까지 당연히 `INSERT`, `UPDATE`, `DELETE`, `SELECT...FOR UPDATE` 와 같은 구문에서 모두 X락을 잡는다고 생각해왔는데, 공식문서에 이러한 언급이 없어서 잘못 알고 있었나 하는 생각이 들었다.

실제로 **“INSERT 시에 X락을 안잡는지”** 를 확인하고자 다음과 같은 예제를 만들어 확인해봤다.

```sql
mysql> CREATE TABLE lock_test_table (
  id INT NOT NULL PRIMARY KEY
);

mysql> SELECT * FROM lock_test_table;

+------+
|  id  |
+------+
|  15  |
|  25  |
|  35  |
+------+
```

먼저 위와 같이 id 컬럼을 PK 로 가지고 있는 `lock_test_table` 을 생성해 위와 같이 설정해주었다.

### 단일 트랜잭션에서 `INSERT` 수행하기

이후, 트랜잭션을 시작해 INSERT 문을 하나 작성한 뒤, 해당 트랜잭션이 가지고 있는 잠금 정보를 조회해보자.

`INSERT INTO lock_test_table(id) VALUE (20);` 를 통해 15 와 25 사이에 데이터를 삽입하는 상황을 가정해보자. 만약 INSERT 문 실행 시 정상적으로 X락이 잡힌다면, 삽입 데이터 20에 대해 X락을 잡히는 결과가 나올 것이다.

```sql
mysql> START TRANSACTION;
mysql> INSERT INTO lock_test_table(id) VALUE (20);

mysql>
SELECT ENGINE_TRANSACTION_ID, LOCK_DATA, LOCK_MODE, LOCK_TYPE, LOCK_STATUS
FROM performance_schema.data_locks;

+-----------------------+-----------+-----------+-----------+-------------+
| ENGINE_TRANSACTION_ID | LOCK_DATA | LOCK_MODE | LOCK_TYPE | LOCK_STATUS |
+-----------------------+-----------+-----------+-----------+-------------+
|              42947488 | NULL      | IX        | TABLE     | GRANTED     |
+-----------------------+-----------+-----------+-----------+-------------+
```

X락이 조회가 되기를 기대했지만, 위와 같이 TABLE 레벨에 대해 IX락 만 할당되어 있는 것을 확인할 수 있다.

아직까지 X락이 할당되었는지, 아닌지 알 수 없다.

### 서로 다른 트랜잭션에서 `SELECT...FOR UPDATE` 이후 `INSERT` 하기

```sql
-- session 1
START TRANSACTION;
SELECT * FROM lock_test_table WHERE id = 20 FOR UPDATE;

SELECT ENGINE_TRANSACTION_ID, LOCK_DATA, LOCK_MODE, LOCK_TYPE, LOCK_STATUS
FROM performance_schema.data_locks;

+-----------------------+-----------+-----------+-----------+-------------+
| ENGINE_TRANSACTION_ID | LOCK_DATA | LOCK_MODE | LOCK_TYPE | LOCK_STATUS |
+-----------------------+-----------+-----------+-----------+-------------+
|              42947489 | NULL      | IX        | TABLE     | GRANTED     |
|              42947489 | 25        | X,GAP     | RECORD    | GRANTED     |
+-----------------------+-----------+-----------+-----------+-------------+

-- session 2
START TRANSACTION;
INSERT INTO lock_test_table(id) VALUE (20);

-- session 1
SELECT ENGINE_TRANSACTION_ID, LOCK_DATA, LOCK_MODE, LOCK_TYPE, LOCK_STATUS
FROM performance_schema.data_locks;

+-----------------------+-----------+------------------------+-----------+-------------+
| ENGINE_TRANSACTION_ID | LOCK_DATA | LOCK_MODE              | LOCK_TYPE | LOCK_STATUS |
+-----------------------+-----------+------------------------+-----------+-------------+
|              42947490 | NULL      | IX                     | TABLE     | GRANTED     |
|              42947490 | 25        | X,GAP,INSERT_INTENTION | RECORD    | WAITING     |
|              42947489 | NULL      | IX                     | TABLE     | GRANTED     |
|              42947489 | 25        | X,GAP                  | RECORD    | GRANTED     |
+-----------------------+-----------+------------------------+-----------+-------------+

-- session 1
COMMIT;

SELECT ENGINE_TRANSACTION_ID, LOCK_DATA, LOCK_MODE, LOCK_TYPE, LOCK_STATUS
FROM performance_schema.data_locks;

+-----------------------+-----------+------------------------+-----------+-------------+
| ENGINE_TRANSACTION_ID | LOCK_DATA | LOCK_MODE              | LOCK_TYPE | LOCK_STATUS |
+-----------------------+-----------+------------------------+-----------+-------------+
|              42947501 | NULL      | IX                     | TABLE     | GRANTED     |
|              42947501 | 25        | X,GAP,INSERT_INTENTION | RECORD    | GRANTED     |
+-----------------------+-----------+------------------------+-----------+-------------+
```

1. 먼저 **session 1** 에서 트랜잭션을 시작하고, id=20 인 조건에 대해 **SELECT...FOR UPDATE** 를 통해 X락을 얻는다.
   - 여기서 performance_schema.data_locks 테이블을 조회하면,
   - `테이블에 대한 IX 락`과 `25번 인덱스 레코드에 대한 X,GAP 락`을 할당받은 것을 확인할 수 있다.
2. **session 2** 에서 트랜잭션을 시작하고, 20을 INSERT 한다.
   - 다시 **session 1** 로 돌아와 performance_schema.data_locks 테이블을 조회하면,
   - `테이블에 대한 IX 락`을 할당받았고,
   - `25번 인덱스 레코드에 대한 X,GAP,INSERT_INTENTION 락`이 대기 중인 것을 확인할 수 있다.
3. **session 1** 커밋
   - **session 1** 을 커밋한 후 performance_schema.data_locks 테이블을 조회하면,
   - 대기중이던 `X,GAP,INSERT_INTENTION 락`이 할당된(GRANTED) 상태로 변한 것을 확인할 수 있다.

아직 명확히 어떤 뜻을 가진 것인지는 모르겠지만, 일단 보이지 않던 Lock 정보가 조회되고 할당까지 된 모습을 확인할 수 있다.

다만, LOCK_DATA 가 25 인덱스 레코드에 대해 `X,GAP,INSERT_INTENTION 락` 을 가지고 있는 것을 보아, 당초 기대했던 삽입 데이터인 20에 대해 X락을 잡는 기대에는 미치지 못했다.

**그렇다면 새로운 트랜잭션이, 똑같이 lock_test_table 에 대해 20을 INSERT 한다면 어떤 결과가 나올까?**

```sql
-- session 3
START TRANSACTION;
INSERT INTO lock_test_table(id) VALUE (20);

SELECT ENGINE_TRANSACTION_ID, LOCK_DATA, LOCK_MODE, LOCK_TYPE, LOCK_STATUS
FROM performance_schema.data_locks;

+-----------------------+-----------+------------------------+-----------+-------------+
| ENGINE_TRANSACTION_ID | LOCK_DATA | LOCK_MODE              | LOCK_TYPE | LOCK_STATUS |
+-----------------------+-----------+------------------------+-----------+-------------+
|              42947506 | NULL      | IX                     | TABLE     | GRANTED     |
|              42947506 | 20        | S,REC_NOT_GAP          | RECORD    | WAITING     |
|              42947501 | NULL      | IX                     | TABLE     | GRANTED     |
|              42947501 | 25        | X,GAP,INSERT_INTENTION | RECORD    | GRANTED     |
|              42947501 | 20        | X,REC_NOT_GAP          | RECORD    | GRANTED     |
+-----------------------+-----------+------------------------+-----------+-------------+
```

마지막 행을 보면, 20번 인덱스 레코드에 대해 `X,REC_NOT_GAP` 락이 할당된 것을 확인할 수 있다. 드디어 처음에 기대했던 결과가 조회되었다.

두 번째 행은 **session 3** 가 실행한 INSERT 문에 의해 대기중인 `S,REC_NOT_GAP` 락이다. lock_test_table 테이블에 프라이머리 키(or 유니크 키)가 존재하기 때문에, 중복 체크를 하기 위해 S락을 얻으려고 시도하는 것이다.

### INSERT 문 실행 시 X락은 사용된다… 그런데?

> **위 결과를 통해 직접 확인할 수 있었듯이, MySQL 의 InnoDB 에서는 INSERT 문 실행 시 X락을 사용한다.**

하지만 여전히 이해가 가지 않는 부분이 있다.

위와 같이 X락을 실제로 사용하는데, 왜 최초에 `performance_schema.data_locks` 테이블을 조회했을 때 X락에 대한 정보가 조회되지 않고, 같은 데이터(여기서는 20)를 INSERT 하려는 경합 상황이 되어서야 X,REC_NOT_GAP 락이 실제로 조회되었을까?

구글링을 통해 [**나와 같은 궁금증을 가진 사람이 남긴 질문과 그에 대한 답변**](https://bugs.mysql.com/bug.php?id=104431)을 찾을 수 있었다.

## 2. 왜 data_locks 테이블에서 바로 조회되지 않는가?

[**위 답변**](https://bugs.mysql.com/bug.php?id=104431)에서는 이를 `Implicit Lock` 과 `Explicit Lock` 을 통해 설명한다. 먼저 이 두 가지를 정리하고 가자.

> 📌 **Implicit Lock 과 Explicit Lock**
>
> **암묵적 잠금(implicit lock)**
>
> - 메모리에서 명시적으로 관리되지 않는 잠금
> - 트랜잭션이 특정 행을 삽입하거나 수정할 때, 다른 트랜잭션이 해당 행에 접근하지 못하도록 암묵적으로 설정된다
>
> **명시적 잠금(explicit lock)**
>
> - 메모리에 명시적으로 저장되고 관리되는 잠금
> - `performance_schema.data_locks` 테이블이나 `SHOW ENGINE INNODB STATUS` 명령을 통해 확인할 수 있다

InnoDB 는 **MVCC 엔진**이기 때문에 **데이터베이스의 일관성과 무결성을 유지하기 위해서**, 트랜잭션이 row 를 INSERT 할 때 InnoDB는 INSERT 연산을 하는 트랜잭션이 커밋되기 전까지 다른 트랜잭션이 이 새로운 행을 보지 못하도록 해야 한다(트랜잭션 격리 수준과 연관).

쉽게 말해, **`트랜잭션A가 INSERT 한 데이터가 커밋되기 전까지, 트랜잭션B가 트랜잭션A에 의해 INSERT 된 새로운 행을 보지 못하도록 해야 한다`** 는 목표를 달성해야 하는 것이다.

이 목표를 달성하기 위해서 InnoDB 는 다음 두 가지 방법을 사용한다.(몇 개가 더 있는지는 모르겠다)

1. **명시적 잠금을 사용하는 것 : `performance_schema.data_locks`에서 확인할 수 있는 것**
2. **암묵적 잠금을 사용하는 것 : `performance_schema.data_locks`나 `SHOW ENGINE INNODB STATUS` 출력에 표시되지 않는 것**

명시적 잠금을 사용한다는 것은 이해가 쉽다. 하지만 암묵적 잠금을 사용한다는 것은 쉽게 이해가 가지 않는다. 위의 설명처럼 `data_locks` 테이블이나 `SHOW ENGINE INNODB STATUS` 을 통해 직접 확인할 수 없다면 어떻게 그것이 실재하는지 알 수 있다는 걸까?

천천히 살펴보자.

### 암묵적 잠금(`Implicit Lock`)의 사용 (feat.추론/유추)

<strong>"암묵적 잠금"</strong>은 메모리 내에서 명시적으로 관리되는 객체가 아니므로 `performance_schema.data_locks`나 `SHOW ENGINE INNODB STATUS` 를 통해 확인할 수 없다. 이 두 매커니즘은 InnoDB 잠금 시스템에서 발견된 명시적 잠금 객체만 반복적으로 검사하기 때문이다.

> **따라서 "암묵적 잠금"은 이름 그대로 `다른 것에 의해 추론`되거나 `논리적으로 유추되는 것`이다.**

이를 추론/유추 하는 방법은 다음과 같다.

먼저 **`트랜잭션A가 INSERT 한 데이터가 커밋되기 전까지, 트랜잭션B가 트랜잭션A에 의해 INSERT 된 새로운 행을 보지 못하도록 해야 한다`** 는 목표를 `공리`(증명할 필요가 없이 자명한 진리이자 다른 명제들을 증명하는 데 전제가 되는 원리로서 가장 기본적인 가정)로 취급한다.

다음 두 가지를 증명하여, 명시적 잠금을 통해 실제로 확인하지 않아도 암묵적으로 잠금을 보유하고 있다고 추론한다. (트랜잭션이 행에 대한 잠금을 보유하고 있음을 추론)

1. **해당 행이 트랜잭션에 의해 생성되었다.**
2. **트랜잭션이 아직 커밋되지 않았다.**

하나하나 증명해보자.

1. **“해당 행이 트랜잭션에 의해 생성되었다” 증명하기**
   - InnoDB는 각 행에 대해 TRX_ID 필드를 사용하여 마지막으로 해당 행을 변경한 트랜잭션을 추적한다.
   - 이 필드가 현재 트랜잭션 ID와 일치하는 경우, 해당 행이 현재 트랜잭션에 의해 생성되었음을 알 수 있다.
   - InnoDB의 각 행에는 헤더가 있는데, 이 헤더에는 `TRX_ID` 필드가 있다
   - 이 `TRX_ID` 에는, **해당 row 를 가장 최근에 변경(생성,수정,삭제)한 트랜잭션의 ID**가 포함되어 있다
   - 즉, 새로운 row 가 "TRX_ID에 의해 작성되었는지" 쉽게 확인할 수 있다
   - `TRX_ID`를 보면 어떤 트랜잭션이 이 행을 마지막으로 변경했는지 알 수 있기 때문이다
2. **“트랜잭션이 아직 커밋되지 않았다” 증명하기**
   - InnoDB가 트랜잭션이 아직 커밋되지 않았음을 확인하면, 해당 트랜잭션이 변경한 데이터는 아직 확정되지 않았음을 의미한다.
   - InnoDB 는 어떤 트랜잭션이 이미 커밋(또는 롤백)되어 있고 어떤 트랜잭션이 여전히 활성화되어 있는지 알고 있다

위와 같이 증명되었다면 다음은 자명하다.

1. **공리 : 트랜잭션A가 INSERT한 데이터가 커밋되기 전까지, 트랜잭션B는 트랜잭션A에 의해 INSERT 된 새로운 행을 보지 못한다**
2. **새로 INSERT 된 행은 트랜잭션A에 의해 생성되었다**
3. **그리고 트랜잭션A은 아직 커밋되지 않았다**
4. **따라서 트랜잭션B는 트랜잭션A에 의해 INSERT 된 새로운 행을 보지 못한다**

결과적으로 암묵적 잠금은 명시적 잠금과 동일한 효과를 내게 된다. 이를 통해 암묵적 잠금을 보유하고 있다고 말할 수 있다.

### 암묵적 잠금의 조회와 비용

위 두 작업은 개념적으로는 쉽지만, 이를 실제로 확인(조회)하기 위해서는 다음과 같은 비용이 발생한다.

1. **행 접근 비용**
   - 암묵적 잠금을 확인(조회)하려면 먼저 해당 행에 접근할 수 있어야 한다. 즉 그 행의 바이트(특히 TRX_ID 필드)를 읽을 수 있어야 한다.
   - TRX_ID 를 확인하려면 다음과 같은 조건이 필요하다.
     - **레코드의 페이지가 버퍼 풀에 있어야 함**: 해당 행이 포함된 페이지가 메모리에 있어야 한다.
     - **페이지를 latch 해야 함**: 페이지에 대한 접근을 동기화하기 위해 페이지 latch 가 필요하다.
     - **어떤 레코드를 확인할지 알아야 함**: 확인할 레코드의 위치를 알고 있어야 한다.
2. **경합 조건 방지 비용**
   - InnoDB는 "TRX_ID가 여전히 활성 상태인지"에 대한 질문에 대한 답변이 신뢰할 수 있고 정확하게 이루어지도록 보장해야 한다.
   - 이를 위해 경합 조건을 피하기 위한 복잡한 조정이 필요하다.

정리하면, 위와 같은 이유로 방대한 데이터베이스에서 수십억 개의 레코드 중, **잠재적 암묵적 잠금**을 보유하고 있을 수 있는 레코드를 검사하는 것은 불가능하다. 이를 가속화하기 위한 "힌트 목록"이 필요할 수 있지만, 이는 결국 `명시적 잠금과 구별되지 않게 되어` 암묵적 잠금의 이점을 잃게 된다.

**즉, 암묵적 잠금의 "획득"은 무료이지만, 이를 확인하는 것은 여전히 다소 비용이 든다.**

따라서 InnoDB 에서는 이를 `Optimistic(낙관적)` 하게 판단한다.

- 필요하지 않으면 비용을 지불하지 않는다.
- 필요할 때는 이미 비용이 많이 드는 명시적 잠금 획득을 수행한다
- 이를 통해 암묵적 잠금 확인 비용을 숨길 수 있다.

### `암묵적 잠금`에서 `명시적 잠금`으로의 변환

[**데드락 감지 및 충돌 확인과 같은 알고리즘은 `명시적 잠금을 기반으로 작동`**](https://dev.mysql.com/blog-archive/innodb-data-locking-part-2-5-locks-deeper-dive/)한다. 즉, 이러한 알고리즘을 사용하기 위해서는 “암묵적 잠금”을 “명시적 잠금”으로 변환해주는 과정을 거쳐야 한다.

따라서 트랜잭션이 특정 행에 대한 Lock 을 얻으려고 할 때,

1. 먼저 다른 트랜잭션이 해당 행에 대해 **"암묵적 잠금을 보유"하고 있는지 확인**한 다음,
2. 이를 `LOCK_X`|`LOCK_REC`|`LOCK_REC_NOT_GAP` 플래그가 있는 동등한 **명시적 잠금으로 변환**한다.

이 작업은 암묵적 잠금을 보유한 스레드가 아니라, 해당 행을 다시 잠그고자 하는 스레드에서 수행된다.

이 부분에 대한 설명이 조금 헷갈려서, 위에서 사용했던 예제를 다시 활용해 `THREAD_ID` 를 조회해봤다.

```sql
-- session 1
START TRANSACTION;
INSERT INTO lock_test_table(id) VALUE (20);

-- session 2
START TRANSACTION;
INSERT INTO lock_test_table(id) VALUE (20);

-- session 1
SELECT ENGINE_TRANSACTION_ID, LOCK_DATA, LOCK_MODE, LOCK_TYPE, LOCK_STATUS
FROM performance_schema.data_locks;

+-----------+-----------------------+-----------+---------------+-----------+-------------+
| THREAD_ID | ENGINE_TRANSACTION_ID | LOCK_DATA | LOCK_MODE     | LOCK_TYPE | LOCK_STATUS |
+-----------+-----------------------+-----------+---------------+-----------+-------------+
|       116 |              42947527 | NULL      | IX            | TABLE     | GRANTED     |
|       116 |              42947527 | 20        | S,REC_NOT_GAP | RECORD    | WAITING     |
|       115 |              42947522 | NULL      | IX            | TABLE     | GRANTED     |
|       116 |              42947522 | 20        | X,REC_NOT_GAP | RECORD    | GRANTED     |
+-----------+-----------------------+-----------+---------------+-----------+-------------+
```

위의 결과를 잘 살펴보면 3,4번 행의 `ENGINE_TRANSACTION_ID` 는 동일하지만, `THREAD_ID` 는 각각 115, 116번으로 다르다는 것을 확인할 수 있다.

또한 session2에 의해 실행된 트랜잭션의 결과인 1,2번 행 `THREAD_ID` 가 116번으로, 4번 행의 `THREAD_ID` 와 같다는 것도 확인할 수 있다.

> **“암묵적 잠금”을 ”명시적 잠금”으로 변환하는 작업은, 암묵적 잠금을 보유한 스레드(115)가 아니라, 해당 행을 잠그고자 하는 스레드(116)에서 수행된다.**
>
> 다시 말해, <strong>‘나중에 오는 트랜잭션’</strong>이 <strong>‘암묵적 잠금을 보유한 이전 트랜잭션’</strong>을 대신해 명시적 잠금을 생성하는 것이다.

다만 명시적 잠금을 생성한 스레드가 116번이라고 해서, 해당 스레드가 잠금을 소유하고 있다는 뜻은 아니다. 4행의 `ENGINE_TRANSACTION_ID` 은 여전히 42947522 로 유지되고 있는 것을 확인할 수 있다.

이것이 `performance_schema.data_locks`을 조회했을 때 `THREAD_ID` 열에 “암묵적 잠금” 에서 “명시적 잠금”으로 변환을 수행한 스레드인 116번이 표시되는 이유이다.

또한 `ENGINE_TRANSACTION_ID` 가 명확히 명시적 잠금의 실제 소유자를 나타내는 이유이다.

> 📌 **참고 :** [**Performance Schema 의 data_locks 테이블**](https://dev.mysql.com/doc/mysql-perfschema-excerpt/8.0/en/performance-schema-data-locks-table.html)
>
> > **THREAD_ID**
> >
> > - 잠금을 “생성”한 세션의 스레드 ID
> >
> > **ENGINE_TRANSACTION_ID**
> >
> > - 잠금을 “요청”한 트랜잭션의 스토리지 엔진 내부 ID
> > - 잠금의 “소유자”로 간주할 수 있다.
> > - LOCK_STATUS=WAITING 이라면 잠금이 아직 부여되지 않은 상태이다
>
> 잠금 요청을 분석할 때는 `ENGINE_TRANSACTION_ID` 열만 보는 것이 좋다.
>
> `THREAD_ID` 열은 `<THREAD_ID,EVENT_ID>` 쌍의 일부로, 이벤트 테이블과 조인하여 타임라인을 재구성하는 데 사용된다.

### 요약

- 행은 잠겨 있으며, 암묵적 잠금일 뿐 명시적 잠금이 아니다.
- 보고 기능은 거의 정의상 명시적 잠금만 처리한다.
- 암묵적 잠금은 필요할 때 명시적 잠금으로 변환될 수 있으며, 이는 관심 있는 스레드에서 지연 수행된다.
- `ENGINE_TRANSACTION_ID` 와 `THREAD_ID`는 두 가지 다른 목적을 가지고 있다.

## 3. LOCK_MODE : X,GAP,INSERT_INTENTION 이 의미하는 건?

[위에서 들었던 예시 코드](#서로-다른-트랜잭션에서-selectfor-update-이후-insert-하기)에서 performance_schema.data_locks 테이블 정보를 보다 보면, `LOCK_MODE` 컬럼에 여러 가지의 플래그들이 있는 것을 확인할 수 있다.

다시 한번 동일한 예시 코드를 살펴보자.

```sql
SELECT * FROM lock_test_table;
+----+
| id |
+----+
| 15 |
| 25 |
| 35 |
+----+

-- session 1
START TRANSACTION;
SELECT * FROM lock_test_table WHERE id = 20 FOR UPDATE;

-- session 2
START TRANSACTION;
INSERT INTO lock_test_table(id) VALUE (20);

-- session 1
COMMIT;

-- session 3
START TRANSACTION;
INSERT INTO lock_test_table(id) VALUE (20);

SELECT THREAD_ID, ENGINE_TRANSACTION_ID, LOCK_DATA, LOCK_MODE, LOCK_TYPE, LOCK_STATUS
FROM performance_schema.data_locks;

+-----------------------+-----------+------------------------+-----------+-------------+
| ENGINE_TRANSACTION_ID | LOCK_DATA | LOCK_MODE              | LOCK_TYPE | LOCK_STATUS |
+-----------------------+-----------+------------------------+-----------+-------------+
|              42947506 | NULL      | IX                     | TABLE     | GRANTED     |
|              42947506 | 20        | S,REC_NOT_GAP          | RECORD    | WAITING     |
|              42947501 | NULL      | IX                     | TABLE     | GRANTED     |
|              42947501 | 25        | X,GAP,INSERT_INTENTION | RECORD    | GRANTED     |
|              42947501 | 20        | X,REC_NOT_GAP          | RECORD    | GRANTED     |
+-----------------------+-----------+------------------------+-----------+-------------+
```

락을 얻는 과정은 위 내용에서 전부 살펴봤으니, 이번에는 각 행이 의미하는 바에 주목해보자.

이 중에서도 내가 궁금했던 것은, **“LOCK_MODE 를 어떻게 해석해야 하는가”** 였다.<br>
특히 5번 행에 `X,GAP,INSERT_INTENTION` 락이 의미하는 바를 이해하기 어려웠다.

나름대로 다음과 같이 해석했었다.

- 20을 INSERT 하기 위해서 InnoDB 는 15와 25 사이에 `Gap 락`을 잡으려 시도한다
- 이때 `Gap 락`은 `INSERT_INTENTION 락`과 함께 사용되어, 삽입하려는 데이터가 Gap 내의 동일한 위치에 삽입되지 않으면, 서로를 기다릴 필요가 없도록 <strong>“삽입 의도”</strong>를 설정한다
- 실제로 데이터를 INSERT 할때, 사용할 `X락`을 잡는다

즉, `X,GAP,INSERT_INTENTION` 락에서 `,` 를 기준으로 세 가지의 락이 잡힌다고 해석한 것이다.

[**InnoDB 데이터 Locking**](https://dev.mysql.com/blog-archive/innodb-data-locking-part-2-locks/)  에서는 이 LOCK_MODE 를 `접근 권한(Access Right)`으로 설명한다.

### 레코드와 갭에 대한 접근 권한

InnoDB는 레코드와 갭을 독립적으로 잠글 수 있는 여러 가지 접근 권한을 정의하고 있다. 이 접근 권한들은 performance_schema.data_locks 테이블의 `LOCK_MODE` 컬럼에 다음과 같이 표시된다.

- `S,REC_NOT_GAP`
  - 레코드 자체에 대한 공유 접근 권한
- `X,REC_NOT_GAP`
  - 레코드 자체에 대한 배타적 접근 권한
- `S,GAP`
  - 행 이전의 갭에 아무도 삽입하지 못하게 막는 권한
- `X,GAP`
  - 행 이전의 갭에 아무도 삽입하지 못하게 막는 권한
  - "S"와 "X"는 각각 "공유"와 "배타"의 약자지만, 이 접근 권한의 의미는 **삽입을 막는 것**이므로 여러 스레드가 충돌 없이 동일한 것을 막는 것에 동의할 수 있다
  - 현재 InnoDB는 `S,GAP`과 `X,GAP`을 동일하게 처리한다: `*,INSERT_INTENTION`과만 충돌한다
- `S`
  - `S,REC_NOT_GAP` + `S,GAP`
  - 따라서 이는 행에 대한 공유 접근 권한이며, 그 이전에 삽입을 방지한다
  - 즉, Next-key Lock 이다
- `X`
  - `X,REC_NOT_GAP` + `X,GAP`
  - 따라서 이는 행에 대한 배타적 접근 권한이며, 그 이전에 삽입을 방지한다.
  -  즉, Next-key Lock 이다.
- `X,GAP,INSERT_INTENTION`
  - 이 행 이전의 갭에 새 행을 삽입할 수 있는 권한
  - 이름에 "X"가 들어있지만 실제로는 동시에 삽입하려는 다른 스레드와 호환된다.
- `X,INSERT_INTENTION`
  - 개념적으로는 위와 동일
  - 페이지의 마지막 레코드 이후의 갭을 나타내는 "supremum pseudo-record"에 대해서만 발생한다.

이를 바탕으로 위에서 살펴본 예제를 다시 해석하면 다음과 같다.

```sql
+-----------------------+-----------+------------------------+-----------+-------------+
| ENGINE_TRANSACTION_ID | LOCK_DATA | LOCK_MODE              | LOCK_TYPE | LOCK_STATUS |
+-----------------------+-----------+------------------------+-----------+-------------+
|              42947501 | 25        | X,GAP,INSERT_INTENTION | RECORD    | GRANTED     |
+-----------------------+-----------+------------------------+-----------+-------------+
```

- 20을 INSERT 하기 위해서 InnoDB 는 25 인덱스 레코드 이전의 GAP(15-25)에 새로운 행을 INSERT 할 수 있는 권한을 획득한다.

즉, 각각의 LOCK_MODE 는 `,` 를 기준으로 나눠서 생각하는 것이 아니라, `하나의 접근 권한`으로 해석하는 것이 이해하기 훨씬 수월하다.

> 📌 **참고 :** [**Insert Intention 락**](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html#innodb-insert-intention-locks)
>
> **`Insert Intention lock`은 row 삽입 전에 INSERT 연산에 의해 설정되는 `Gap lock의 일종`이다.**
>
> 이 잠금은 동일한 인덱스 Gap 에 삽입되는 다수의 트랜잭션이 Gap 내의 동일한 위치에 삽입되지 않으면, 서로를 기다릴 필요가 없도록 “삽입 의도”를 나타낸다.

### LOCK_MODE 의 충돌

아래는 다양한 잠금 모드가 어떻게 충돌하는지 보여주는 표이다. 해당 내용도 [**InnoDB 데이터 Locking**](https://dev.mysql.com/blog-archive/innodb-data-locking-part-2-locks/) 에서 더 자세히 확인할 수 있다.

| 잡고있는 락→<br>——————  요청된 락↓ | `S,REC_NOT_GAP` | `X,REC_NOT_GAP` | `*,GAP` | `S` | `X` | `*,INSERT_INTENTION` |
| --- | --- | --- | --- | --- | --- | --- |
| `S,REC_NOT_GAP` | ✅ | ⌛ | ✅ | ✅ | ⌛ | ✅ |
| `X,REC_NOT_GAP` | ⌛ | ⌛ | ✅ | ⌛ | ⌛ | ✅ |
| `*,GAP` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `S` | ✅ | ⌛ | ✅ | ✅ | ⌛ | ✅ |
| `X` | ⌛ | ⌛ | ✅ | ⌛ | ⌛ | ✅ |
| `*,INSERT_INTENTION` | ✅ | ✅ | ⌛ | ⌛ | ⌛ | ✅ |

- 이미 부여된 INSERT_INTENTION 에 대해서는 아무도 신경 쓰지 않는다.
  - 이는 이 접근 권한이 부여되자마자 즉시 "소비"되기 때문이다.
  - 트랜잭션은 즉시 데이터베이스에 새 레코드를 삽입하여, (이전) 행 앞의 갭을 두 개의 갭으로 나눈다.
  - 때문에 어떤 의미에서는 이전 접근 권한이 더 이상 필요하지 않거나 유효하지 않아 무시된다.
- `*,GAP` 잠금은 어떤 경우에도 즉시 부여된다.
  - 이는 "잠금 분할(lock splitting)" 기술에서 많이 사용된다.
  - 특히, `INSERT_INTENTION` 은 `*,GAP` 을 기다려야 하지만 그 반대는 아니다.
  - 이는 충돌 관계가 대칭적이지 않음을 의미한다.
- `INSERT_INTENTION` 은 `S`를 기다려야 하고, `S` 는 `X,REC_NOT_GAP` 을 기다려야 하지만, `INSERT_INTENTION` 은 `X,REC_NOT_GAP` 을 기다릴 필요가 없다.

이러한 것들은 구현 세부 사항이며, 미래 버전에서는 변경될 수 있다.

## 결론

**Q : INSERT 문 실행 시 InnoDB 는 X락을 사용하는가**

**A: 사용한다.**

**Q : 사용한다면 왜 performance_schema.data_locks 테이블에서 바로 조회되지 않는가**

**A : InnoDB 는 INSERT 문 실행 시 “암묵적 잠금” 을 통해 행을 잠그는데, 이를 통해 “명시적 잠금”의 비용을 절약할 수 있다. “암묵적 잠금”을 사용하면 data_locks 테이블에서 조회할 수 없다. Optimistic 하게 사용되며, 실제로 잠금이 필요할 때 “암묵적 잠금”을 “명시적 잠금”으로 변환해 X락을 얻는다.**

**Q : LOCK_MODE 를 어떻게 해석해야 하는가**

**A : `접근 권한`으로 해석하자**

**Q : INSERT 문 실행 시 획득되는 락의 순서는?**

**A : 일반적으로 다음과 같이 나열할 수 있다.**

1. **`IX` 락** : 테이블 레벨에서 IX 락 접근 권한을 획득한다.
2. **`S` 락** : 삽입 데이터에 PK 나 UNIQUE INDEX 가 존재한다면, 중복 확인을 위해 S 락 접근 권한을 획득하기도 한다.
3. **`X,GAP,INSERT_INTENTION` 락** : 삽입 위치의 갭에 대해 X,GAP,INSERT_INTENTION 락 접근 권한을 획득한다.
4. **`X,REC_NOT_GAP` 락** : 삽입된 행에 대해 X,REC_NOT_GAP 락 접근 권한을 획득한다.

**다만, “암묵적 잠금”을 기본적으로 사용하는 특성 상, 항상 위의 순서대로 data_locks 테이블에서 조회되지 않는 것 뿐 아니라, 다른 트랜잭션의 영향을 많이 받기 때문에, 위 과정에서 문제가 발생한다면 반드시 직접 확인하는 것이 좋을 것이라고 생각된다.**

## 참고 자료

[https://bugs.mysql.com/bug.php?id=104431](https://bugs.mysql.com/bug.php?id=104431)

[https://dev.mysql.com/blog-archive/innodb-data-locking-part-2-locks/](https://dev.mysql.com/blog-archive/innodb-data-locking-part-2-locks/)

[https://dev.mysql.com/blog-archive/innodb-data-locking-part-2-5-locks-deeper-dive/](https://dev.mysql.com/blog-archive/innodb-data-locking-part-2-5-locks-deeper-dive/)

[https://medium.com/daangn/mysql-gap-lock-다시보기-7f47ea3f68bc](https://medium.com/daangn/mysql-gap-lock-%EB%8B%A4%EC%8B%9C%EB%B3%B4%EA%B8%B0-7f47ea3f68bc)

[https://medium.com/daangn/mysql-gap-lock-두번째-이야기-49727c005084](https://medium.com/daangn/mysql-gap-lock-%EB%91%90%EB%B2%88%EC%A7%B8-%EC%9D%B4%EC%95%BC%EA%B8%B0-49727c005084)
