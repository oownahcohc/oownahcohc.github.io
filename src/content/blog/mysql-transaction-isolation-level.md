---
title: '트랜잭션과 트랜잭션 격리 수준 (isolation level)'
description: '트랜잭션과 트랜잭션 격리 수준'
pubDate: '2023-07-29'
tags: ['mysql', 'transaction', 'database', 'real-mysql']
series:
  id: real-mysql
  order: 7
  label: '트랜잭션과 격리 수준'
---

## 트랜잭션이란? (transaction)

> <strong>트랜잭션(transaction)</strong>이란 <strong>"쪼갤 수 없는 업무 처리의 최소 단위"</strong>를 말한다.<br>
> 트랜잭션은 성공과 실패가 분명하고 상호 독립적이며, 일관되고 믿을 수 있어야 한다.
>
> 즉, [**ACID**](https://ko.wikipedia.org/wiki/ACID) 를 보장해야 한다.

트랜잭션은 위와 같이 정의 내릴 수 있다. 다만, 처음 마주한다면 이해하기에 조금 어려움을 겪을 수 있다.

먼저 트랜잭션이 보장해줘야 하는 **ACID** 가 무엇인지 간단히 살펴보자.

### ACID

- **원자성 (Atomicity)**

  트랜잭션 내에서 실행한 작업들은 **"`모두 성공하거나, 모두 실패하거나`"** 여야 한다. 쉽게 말하면 "모 아니면 도" 인 것이다.

- **일관성 (Consistency)**

  모든 트랜잭션은 `일관성` 있는 데이터베이스 상태를 유지해야 한다. 예를 들어, 데이터베이스에서 정한 `무결성 제약 조건`을 항상 만족해야 한다.

- **격리성 (Isolation)**

  동시에 실행되는 `트랜잭션들이 서로에게 영향을 미치지 않도록` 격리해야 한다. 예를 들어, 동시에 같은 데이터를 수정하지 못하도록 해야 한다. 격리성은 `동시성`과 관련된 성능 이슈로 인해 격리 수준을 선택할 수 있다.

- **지속성 (Durability)**

  트랜잭션을 성공적으로 끝내면 그 `결과는 항상 기록`되어야 한다. 중간에 시스템에 문제가 발생해도 데이터베이스 로그 등을 사용해 성공한 트랜잭션 내용을 복구해야 한다.

> 🙋🏻‍♂️ **그래서 트랜잭션이 필요한 이유는?**
>
> 트랜잭션이 필요한 이유를 묻는다면 트랜잭션을 사용하지 않을 때의 참사를 떠올려보면 된다.
>
> 결론만 말하자면 <strong>시스템에 문제가 발생했을 때 부분적으로만 업데이트가 일어나는 `Partial Update를 효과적으로 처리`</strong>하여 **`정합성`을 맞추는데 큰 도움**을 주기 때문이다.

### 🚨 주의사항 : 트랜잭션의 범위

> DBMS의 커넥션과 동일하게 **꼭 필요한 최소의 코드에만 적용해 트랜잭션의 범위를 최소화** 해야한다.

- 일반적으로 데이터베이스 커넥션은 개수가 제한적이다. 따라서 각 단위 프로그램이 커넥션을 소유하는 시간이 길어지게 되면 사용 가능한 커넥션의 개수는 줄어들 수 밖에 없다.
- 메일 전송이나 FTP 파일 전송 작업, 네트워크를 통해 원격 서버와 통신하는 등의 작업은 트랜잭션에서 반드시 분리해야 한다. 만약 프로그램 실행 도중 메일 서버와의 통신 장애가 발생하면 웹 서버 뿐 아니라 DBMS 서버까지 영향을 미치게 된다.
- 작업의 단위를 잘 나누고, 작업 별로 별도의 트랜잭션으로 분리하는 것이 좋다.
- 단순 조회 작업은 트랜잭션을 사용하지 않아도 된다.

## 트랜잭션 격리 수준 (transaction isolation level)

> 💡 **트랜잭션의 격리 수준(isolation level)이란?**
>
> 여러 트랜잭션이 동시에 처리될 때, **특정 트랜잭션**이 **다른 트랜잭션**에서 변경하거나 조회하는 데이터를 볼 수 있게 허용할지 말지를 결정하는 것이다.

트랜잭션은 위 ACID 중 원자성, 일관성, 지속성을 보장한다. 하지만 위에서 말했듯이 ACID 모두를 만족시켜야 한다. 그렇다면 문제는 격리성인데, 트랜잭션 간 격리성을 완벽하게 보장하기 위해서는 트랜잭션을 차례대로 실행해야 한다. 하지만 이렇게 한다면 동시성 처리 성능이 매우 떨어지게 될 것이 불을 보듯 뻔하다.

이러한 문제로 MySQL은 트랜잭션의 격리 수준을 4단계로 나누어 정의한다. 4단계는 다음과 같다.

1. **`READ UNCOMMITTED`** (커밋되지 않은 읽기)
2. **`READ COMMITTED`** (커밋된 읽기)
3. **`REPEATABLE READ`** (반복 가능한 읽기)
4. **`SERIALIZABLE`** (직렬화 가능)

**`READ UNCOMMITTED`** 의 격리 수준이 가장 낮고, 아래로 내려갈수록 격리 수준이 높아지며 **`SERIALIZABLE`** 의 격리 수준이 가장 높다. **격리 수준이 낮으면 동시성 처리 성능이 좋다**. 그렇다면 **`READ UNCOMMITTED`** 격리 수준이 가장 좋은걸까?

안타깝게도 그렇지 않다. 격리 수준에 따라 다양한 문제들이 발생할 수 있는데, 지금부터 살펴보도록 하자.

### 1. READ UNCOMMITTED (커밋되지 않은 읽기)

> 💡 커밋되지 않은 데이터를 읽을 수 있다. 각 트랜잭션에서의 변경 내용이 `COMMIT` 이나 `ROLLBACK` 여부에 관계없이 다른 트랜잭션에서 보인다.

사용자 A와 사용자 B가 각각 INSERT 와 SELECT 를 실행한다고 해보자.

<img src="/images/mysql-transaction-isolation-level/01.png" alt="READ UNCOMMITTED에서 사용자 A가 Lara를 INSERT하고 커밋하기 전에 사용자 B의 SELECT가 그 레코드 1건을 반환받는 흐름" width="1062" height="986" loading="lazy" decoding="async" style="max-width: 550px" />

1. 사용자 A가 트랜잭션을 시작하고, employees 테이블에 'Lara' 를 INSERT 한다. 아직 COMMIT 하지 않은 상태이다.
2. 이때, 사용자 B가 'Lara' 에 해당하는 데이터를 SELECT 한다. 놀랍게도 사용자 B는 해당 데이터를 조회할 수 있다.
3. 문제는 사용자 A가 처리 도중 시스템에 장애가 생겨 INSERT 한 내용을 ROLLBACK 할 때 발생한다.
4. 사용자 A는 내용을 롤백했지만 사용자B 는 여전히 'Lara'가 정상적인 사원(employees)으로 판단해 처리할 것이다.

위와 같이 **하나의 트랜잭션에서 처리한 작업이 완료되지(커밋되지) 않았음에도 다른 트랜잭션에서 조회할 수 있는 현상**을 **더티 리드(DIRTY READ)** 라고 한다. **`READ UNCOMMITTED`** 격리 수준은 **더티 리드**를 허용하기 때문에 데이터 정합성에 심각한 문제를 초래할 수 있다.

따라서 MySQL 에서는 **`READ UNCOMMITTED`** 이상의 격리 수준을 사용해야 한다.

### 2. READ COMMITTED (커밋된 읽기)

> 💡 커밋한 데이터만 읽을 수 있다.

#### 1) 더티 리드의 해결

**`READ COMMITTED`** 격리 수준은 오라클 DBMS에서 기본으로 사용되며, 온라인 서비스에서 가장 많이 선택한다.

이 격리 수준에서는 **더티 리드**는 발생하지 않는다. 예시와 함께 살펴보자.

<img src="/images/mysql-transaction-isolation-level/02.png" alt="READ COMMITTED에서 사용자 A가 Lara를 Toto로 바꾸고 커밋하기 전에 사용자 B의 SELECT는 테이블이 아닌 언두 로그의 Lara를 반환받는 흐름" width="1082" height="974" loading="lazy" decoding="async" style="max-width: 550px" />

1. 사용자 A가 트랜잭션을 시작하고, 'emp_no'가 500000 인 데이터에 대한 값을 'Lara' 에서 'Toto' 로 수정한다.
2. 이때 'Toto' 는 employees 테이블에 즉시 기록되고, 이전 값인 'Lara' 는 언두 영역으로 백업된다.
3. 사용자 A가 트랜잭션을 커밋하기 전에 사용자 B가 'emp_no'가 500000 인 데이터를 SELECT 한다. 커밋되지 않았기 때문에 SELECT 쿼리 결과는 언두 영역에 백업된 레코드에서 가져온다.
4. 사용자 A가 트랜잭션을 커밋하면, 다른 트랜잭션에서도 'Toto'를 조회할 수 있다.

이렇게 **`READ COMMITTED`** 격리 수준을 사용하면 **더티 리드**와 같은 문제는 발생하지 않는다.

하지만 **NON-REPEATABLE READ** 라는 문제가 발생한다.

#### 2) NON-REPEATABLE READ : "반복 불가능한 읽기"의 발생

> 💡 **`REPEATABLE READ`가 불가능한 상태**로, **하나의 트랜잭션 내에서 항상 같은 데이터를 읽을 수 없는 상태**를 말한다.

더티 리드를 허용하지 않으면서 골치아픈 상황은 벗어났지만, <strong>`REPEATABLE READ`</strong>가 불가능한 부정합의 문제가 새롭게 발생한다.

예시와 함께 살펴보자.

<img src="/images/mysql-transaction-isolation-level/03.png" alt="READ COMMITTED에서 사용자 B가 first_name='Toto'를 조회하면 처음엔 결과가 없고, 사용자 A가 Toto로 바꿔 커밋한 뒤에는 같은 조회가 1건을 반환하는 흐름" width="1082" height="986" loading="lazy" decoding="async" style="max-width: 550px" />

1. 사용자 B가 트랜잭션을 시작하고, 'first_name' 이 'Toto' 인 사원을 찾는다. 아쉽게도 그런 직원은 없다.
2. 이때 사용자 A가 트랜잭션을 시작, 사원 번호가 500000 인 사원의 이름을 'Toto'로 변경하고 커밋한다.
3. 사용자 B가 다시 'first_name' 이 'Toto' 인 사원을 SELECT 쿼리를 통해 조회하면, 이번에는 조회가 된다.

흐름만 놓고 본다면 뭐가 문제인가 싶기도 하다. 하지만, 사용자 B의 트랜잭션 내에서 똑같은 조건으로 SELECT 쿼리를 실행했을 때에는 항상 같은 결과를 가져와야 하는 **`REPEATABLE READ`** 정합성에 부합하지 못한다.

### 3. REPEATABLE READ (반복 가능한 읽기)

> 💡 한 번 조회한 데이터를 반복해서 조회해도 같은 데이터가 조회된다.

**`REPEATABLE READ`** 격리 수준은 **MySQL의 InnoDB 스토리지 엔진에서 기본으로 사용**하는 격리 수준이다.

바이너리 로그를 가진 MySQL 서버에서는 최소 **`REPEATABLE READ`** 격리 수준 이상을 사용해야 한다.

#### 1) NON-REPEATABLE READ 의 해결

**`REPEATABLE READ`** 격리 수준이 작동하는 방식을 살펴보도록 하자.

employees 테이블은 현재 <strong>6번 트랜잭션(TRX-ID = 6)</strong>에 의해 INSERT 되어 있는 상태이다.

<img src="/images/mysql-transaction-isolation-level/04.png" alt="REPEATABLE READ에서 트랜잭션 10(사용자 B)이 Lara를 읽은 뒤 트랜잭션 12(사용자 A)가 Toto로 바꿔 커밋해도, B의 두 번째 조회는 언두 로그의 Lara(TRX-ID 6)를 반환하는 흐름" width="1232" height="1234" loading="lazy" decoding="async" style="max-width: 550px" />

1. 사용자 B의 트랜잭션 10이 시작되고, 사원 번호가 500000인 사원을 SELECT 로 조회한다. 'Lara' 를 조회했다.
2. 사용자 A의 트랜잭션 12가 시작되고, 사원 번호가 500000인 사원의 이름을 'Toto' 로 변경한다. 테이블에 즉시 변경이 반영되고, 변경 전 데이터 'Lara' 는 언두 로그에 복사된다. 변경이 완료되면 트랜잭션 12를 커밋한다.
3. 사용자 B가 다시 한번 사원 번호가 500000인 사원을 조회한다. B의 트랜잭션 번호가 10번이기 때문에, 10번 보다 작은 트랜잭션 번호에서 변경한 내용만 본다. 따라서 언두 로그의 백업된 6번 트랜잭션 내용이 SELECT 되어 'Lara' 를 조회한다.

위 그림에서는 언두 영역에 백업 데이터가 하나만 존재한다. 하지만 실제로 언두 영역에는 하나의 레코드에 대한 백업이 하나 이상 존재할 수 있다. 언두 영역에 백업된 레코드는, 그 수가 MySQL 서버 처리 성능에 영향을 미치기 때문에 관리가 필요하다.

#### 2) PHANTOM READ (PHANTOM ROWS) : 반복 조회 시 결과의 집합이 달라지는 팬텀 리드의 발생

> 💡 다른 트랜잭션에서 수행한 변경 작업에 의해 레코드가 보였다 안보였다 하는 현상이다.

**`REPEATABLE READ`** 격리 수준에서는 DIRTY READ 와 NON-REPEATABLE READ 와 같은 부정합 문제를 해결했다. 하지만 여전히 문제는 발생한다.  **PHANTOM READ** 가 바로 그것이다.

예시와 함께 살펴보도록 하자.

사용자 A가 employees 테이블에 INSERT

<img src="/images/mysql-transaction-isolation-level/05.png" alt="REPEATABLE READ에서 사용자 B가 SELECT ... FOR UPDATE로 Lara 1건을 조회한 뒤 사용자 A가 Georgi를 INSERT하고 커밋하자, B의 같은 조회가 Lara와 Georgi 2건을 반환하는 흐름" width="1226" height="1152" loading="lazy" decoding="async" style="max-width: 550px" />

1. 사용자 B가 트랜잭션 10을 시작하고 **SELECT...FOR UPDATE** 쿼리를 통해 employees 테이블을 조회한다. 'Lara' 를 조회했다.
2. 사용자 A가 트랜잭션 12를 시작하고 'Georgi' 를 INSERT 한다. 트랜잭션 12는 커밋된다.
3. 사용자 B가 트랜잭션 10 내에서 **SELECT...FOR UPDATE** 쿼리를 다시 실행한다. 이번에는 'Lara' 와 'Georgi' 를 조회했다.

사용자 B의 트랜잭션 10에서 첫 번째 조회 결과와 두 번째 조회 결과가 다른 상황이 벌어졌다.

이러한 현상을 바로 **PHANTOM READ** 라고 한다.

**`SELECT...FOR UPDATE`** 쿼리는 SELECT 하는 레코드에 쓰기 잠금을 걸어야 하는데, 언두 레코드에는 잠금을 걸 수 없다.

따라서 **`SELECT...FOR UPDATE`** , **`SELECT...LOCK IN SHARE MODE`** 로 조회되는 레코드는 언두 영역의 변경 전 데이터를 가져오지 않고, 현재 레코드의 값을 가져온다. 이 때문에 팬텀 리드와 같은 부정합 문제가 발생하게 된다.

### 4. SERIALIZABLE (직렬화 가능)

> 💡 가장 엄격한 격리 수준으로, 하나의 트랜잭션에서 읽고 쓰는 레코드를 다른 트랜잭션에서 절대 접근할 수 없도록 한다.

보통 InnoDB 테이블에서 기본적으로 **순수한 SELECT 작업**은 레코드 잠금을 획득하지 않고 실행한다. InnoDB가 <strong>Non-locking consistent read(잠금 없는 일관된 읽기)</strong>를 지원하기 때문이다.

**`SERIALIZABLE`** 격리 수준에서는 읽기 작업도 공유 잠금(읽기 잠금)을 획득해야만 하고, 동시에 다른 트랜잭션은 해당 레코드를 변경하지 못한다.

가장 엄격한 격리 수준인 만큼, 위에서 발생했던 모든 정합성 문제 (**DIRTY READ**, **NON-REPEATABLE READ**, **PHANTOM READ**) 들이 발생하지 않는다. 하지만 InnoDB 스토리지 엔진에서는 **갭 락**과 **넥스트 키 락**을 활용해 **`REPEATABLE READ`** 격리 수준에서도 PHANTOM READ가 발생하지 않는다. 따라서 굳이 **`SERIALIZABLE`** 을 사용하지 않아도 된다.

트랜잭션 격리 수준을 모두 표로 정리하면 다음과 같다.

<img src="/images/mysql-transaction-isolation-level/06.png" alt="격리 수준별 부정합 표. READ UNCOMMITTED는 DIRTY READ, NON-REPEATABLE READ, PHANTOM READ가 모두 발생하고, READ COMMITTED는 DIRTY READ만 없고, REPEATABLE READ는 PHANTOM READ만 발생하며(InnoDB는 없음), SERIALIZABLE은 셋 다 없다." width="1826" height="540" loading="lazy" decoding="async" />
