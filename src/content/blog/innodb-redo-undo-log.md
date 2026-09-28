---
title: 'Redo Log (리두 로그), Undo Log (언두 로그) - InnoDB 스토리지 엔진 아키텍처 : On-Disk Structures'
description: '리두 로그와 언두 로그 : InnoDB 스토리지 엔진 아키텍처'
pubDate: '2023-07-26'
tags: ['mysql', 'innodb', 'database', 'real-mysql']
series:
  id: real-mysql
  order: 6
  label: '리두 로그와 언두 로그'
---

## InnoDB 스토리지 엔진 아키텍처

<figure>
<img src="/images/innodb-redo-undo-log/01.png" alt="InnoDB Architecture" width="1458" height="1138" loading="lazy" decoding="async" style="max-width: 650px" />
<figcaption>InnoDB Architecture</figcaption>
</figure>

InnoDB 스토리지 엔진은 현재 MySQL의 스토리지 엔진 중 가장 많이 사용된다. InnoDB 는 MySQL 에서 사용할 수 있는 스토리지 엔진 중 거의 유일하게 **레코드 기반의 잠금**을 제공하기 때문에 **높은 동시성 처리**가 가능하며 안정적이고 성능이 뛰어나다.

## 리두 로그 (Redo Log)

<figure>
<img src="/images/innodb-redo-undo-log/02.png" alt="리두 로그" width="264" height="268" loading="lazy" decoding="async" style="max-width: 264px" />
<figcaption>리두 로그</figcaption>
</figure>

> <strong>리두 로그(Redo Log)</strong>는 MySQL 서버가 비정상적으로 종료되었을 때 **복구를 위한 안전장치**이다.<br>
> InnoDB 스토리지 엔진은 데이터의 변경이 발생하면 리두 로그에 기록한다 (언두 로그에도 기록한다).

MySQL 서버가 비정상 종료되는 경우 InnoDB 스토리지 엔진은 **두 가지 종류의 일관성 없는 데이터**를 가질 수 있다.

### 1. COMMIT 되었지만 데이터 파일에 기록되지 않은 데이터

MySQL 서버에서 InnoDB 스토리지 엔진은 데이터 변경 내용을 디스크에 기록하기 전에 로그로 먼저 기록한다.

따라서 리두 로그에 저장된 데이터를 데이터 파일에 다시 복사해주면 해결된다.

### 2. ROLLBACK 되었지만 데이터 파일에 이미 기록된 데이터

InnoDB 스토리지 엔진은 DML 로 변경된 데이터를 언두 로그에 백업한다. 따라서 언두 로그에 저장된 데이터를 데이터 파일에 다시 복사해주면 해결된다. 이때 변경이 커밋되었는지, 롤백되었는지, 아니면 트랜잭션 실행 중간 상태였는지를 확인하기 위해 리두 로그가 사용된다.

**리두 로그는 트랜잭션이 커밋되면 즉시 디스크로 기록되도록 설정**해야 한다. 그래야만 서버의 비정상 종료 시, 직전 트랜잭션 커밋 내용까지 리두 로그에 기록될 수 있고, 해당 리두 로그를 이용해 장애 직전 시점까지의 복구가 가능하기 때문이다.

하지만 트랜잭션이 커밋될 때마다 리두 로그를 디스크에 기록하는 작업은 많은 부하를 유발한다. 이러한 문제를 해결하기 위해 InnoDB 스토리지 엔진은 **리두 로그를 디스크에 동기화하는 주기를 설정**할 수 있는 시스템 변수 **innodb_flush_log_at_trx_commit** 을 제공한다.

### 3. 리두 로그 활성화 및 비활성화

> InnoDB 스토리지 엔진은 데이터 파일에 기록되지 못한 트랜잭션을 복구하기 위해 리두 로그를 사용한다.
>
> **항상 활성화**

MySQL 8.0 버전부터는 수동으로 리두 로그를 활성화 및 비활성화 할 수 있다.

보통 **데이터를 복구하거나 대용량 데이터를 한번에 적재하는 경우 리두 로그를 비활성화해 데이터의 적재 시간을 단축**시킨다.

```sql
ALTER INSTANCE DISABLE INNODB REDO_LOG;

-- // 리두 로그를 비활성화한 후 대량 데이터 적재
LOAD DATA ...

ALTER INSTANCE ENABLE INNODB REDO_LOG;
```

위와 같은 순서로 InnoDB의 리두 로그를 비활성화한 후, 대량의 데이터를 적재하고, 다시 InnoDB의 리두 로그를 활성화 해준다.

**`ALTER INSTANCE [ ENABLE | DISABLE ] INNODB REDO_LOG`** 명령을 실행한 후에는 다음 명령을 통해 InnoDB의 리두 로그가 제대로 `활성화 | 비활성화` 되었는지 확인할 수 있다.

```sql
mysql> SHOW GLOBAL STATUS LIKE 'Innodb_redo_log_enable';
```

위와 같이 리두 로그를 비활성화한 후 데이터 적재 작업을 실행했다면, 데이터 적재 완료 후에 **반드시 리두 로그를 다시 활성화**해줘야 한다. 만약 리두 로그가 비활성화된 상태로 MySQL 서버가 비정상 종료된다면 MySQL 서버의 마지막 체크포인트 이후 시점의 데이터는 모두 복구가 불가능하다. 즉, 리두 로그를 이용한 복구가 불가능하고, 때문에 MySQL 서버는 정상적으로 시작되지 못한다.

이러한 경우 **innodb_force_recovery** 시스템 변수를 6으로 설정한 후 다시 시작해야 하니 주의하도록 하자.

## 언두 로그 (Undo Log)

> InnoDB 스토리지 엔진은 트랜잭션과 격리 수준을 보장하기 위해, DML로 변경되기 **이전의 데이터를 백업**한다. 이때 **백업된 데이터**를 바로 <strong>언두 로그(Undo Log)</strong>라고 한다.

데이터베이스를 다루다 보면 여러가지 이유로 트랜잭션이 `ROLLBACK` 되는 상황들이 있다.<br>
이때 이미 트랜잭션 도중에 DML(INSERT, UPDATE, DELETE)로 변경된 데이터가 트랜잭션 이전으로 복구된다.<br>
어떻게 데이터 변경 쿼리가 날아간 이후인데도 원래의 상태로 복구하는 것이 가능한걸까?

이것을 가능하게 해주는 것이 바로 **언두 로그(Undo Log)** 이다. 언두 로그에 백업해둔 이전 버전의 데이터를 이용해 복구하는 것이다.

위에서 살펴봤듯이, InnoDB 스토리지 엔진에서 MySQL 서버가 비정상 종료될 때, 데이터의 일관성이 깨지는 상황에 대비하여 리두 로그를 사용했다. 그리고 이 리두 로그는 로그 버퍼에 버퍼링되어 트랜잭션 커밋 시에 한번에 디스크로 플러시 된다.

그렇다면 언두 로그도 로그 버퍼에 버퍼링되는 것일까?

그렇지 않다. **언두 로그는 리두 로그와는 다르게 버퍼링 되지 않는다**. 언두 로그는 **언두 영역**에 기록된다.

### 1. 언두 영역

> **언두 영역**은 INSERT, UPDATE, DELETE 와 같은 문장으로 데이터를 변경했을 때, **변경 전의 원본 데이터를 보관하는 영역**이다.

```sql
UPDATE member SET name='홍길동' WHERE member_id=1;
```

위 업데이트 문을 실행하면 **트랜잭션을 커밋하지 않아도** 실제 데이터 파일 내용(member_id=1인 데이터)은 '홍길동'으로 변경된다.

만약 변경 전의 값이 '임꺽정' 이었다면, 언두 영역에는 '임꺽정' 값이 백업된다.

여기서 **트랜잭션이 커밋되면 현 상태가 유지**되고, **롤백되면 언두 영역의 백업 데이터를 다시 데이터 파일로 복구**한다.

---

**🙋🏻‍♂️ 언두 로그 저장 공간에 대한 문제점**

언두 로그를 저장할 공간은 한정적이다. 데이터의 변경이 발생할 때마다 언두 로그에 값을 저장할텐데, 언두 로그 공간 관리는 어떻게 해주는 걸까? 자연스럽게 궁금증이 생기기 마련이다. 이렇게 언두 로그 저장 공간에 대한 문제는 다음 두 가지 상황에서 발생할 수 있다.

**(1) 대용량 데이터를 처리하는 트랜잭션**

만약 100GB 크기의 테이블 데이터를 DELETE 한다면, 해당 테이블에서 레코드를 삭제하고 언두 로그에 이전 데이터를 저장할 것이다.

그렇게 된다면 100GB 크기의 언두 로그 공간이 필요한 상황이 발생한다.

**(2) 오랫동안 실행되는 트랜잭션**

트랜잭션이 완료될 때까지 해당 트랜잭션이 생성한 언두 로그는 삭제되지 않는다. 좀 더 정확한 설명을 위해 다음 예시를 한번 보도록 하자.

<figure>
<img src="/images/innodb-redo-undo-log/03.png" alt="끝나지 않는 트랜잭션..." width="1510" height="544" loading="lazy" decoding="async" style="max-width: 650px" />
<figcaption>끝나지 않는 트랜잭션...</figcaption>
</figure>

3개의 트랜잭션이 실행되었다. 그림에서 볼 수 있듯이 B, C 트랜잭션은 각각 UPDATE, DELETE 를 실행하고 COMMIT 을 완료했다.

하지만 먼저 시작된 A 트랜잭션이 아직 활성상태이다. InnoDB 스토리지 엔진은 MVCC 기술을 이용해 <strong>"잠금 없는 일관된 읽기"</strong>를 수행한다. 이때 언두 로그를 활용하기 때문에 A 트랜잭션이 끝날 때까지 언두 로그를 삭제할 수 없는 것이다.

이렇게 오랜 시간 동안 트랜잭션이 활성 상태라면 **디스크의 언두 로그 저장 공간은 계속 증가하는 상황**이 발생한다.

---

**👨🏻‍🏫  MySQL 8.0 버전의 언두 로그 공간 관리와 모니터링**

MySQL 5.5 버전까지는 언두 로그 사용 공간이 한 번 늘어나면 줄일 수 있는 방법이 없었다.

MySQL 8.0 에서는 **언두 로그를 돌아가면서 순차적으로 사용해 디스크 공간을 줄이는 것**도 가능하고, **MySQL 서버가 필요한 시점에 사용 공간을 자동으로 줄여준다**.

여전히 MySQL 서버에서 트랜잭션이 오랜 시간 활성 상태로 유지되는 것은 성능상 좋지 않다.<br>
그렇기 때문에 MySQL 서버의 언두 로그 레코드를 항상 모니터링 해주는 것이 좋다.

MySQL 서버에서 실행되는 INSERT, UPDATE, DELETE 문장이 얼마나 많은 데이터를 변경하느냐에 따라 평상시 언두 로그에 존재하는 레코드 건수는 상이할 수 있다.

따라서, **안정적인 시점의 언두 로그 레코드 건수를 기준으로 언두 로그의 급증 여부를 모니터링 하는 것이 좋다**.

```sql
-- // 해당 명령어로 언두 레코드 건수 확인이 가능하다 (모든 버전)
SHOW ENGINE INNODB STATUS \G

-- // 해당 명령어로 언두 레코드 건수 확인이 가능하다 (MySQL 8.0 버전)
SELECT count FROM information_schema.innodb_metrics
WHERE SUBSYSTEM='transaction' AND NAME='trx_rseg_history_len';
```

### 2. 언두 테이블스페이스 (Undo Tablespace)

<figure>
<img src="/images/innodb-redo-undo-log/04.png" alt="언두 테이블 스페이스" width="214" height="118" loading="lazy" decoding="async" style="max-width: 300px" />
<figcaption>언두 테이블 스페이스</figcaption>
</figure>

> **언두 로그가 저장되는 공간**을 <strong>언두 테이블스페이스(Undo Tablespace)</strong>라고 한다.
>
> **언두 영역이 곧 언두 테이블스페이스라고 봐도 무방**하다.

먼저 언두 테이블스페이스의 구조를 그림과 함께 살펴보도록 하자.

<figure>
<img src="/images/innodb-redo-undo-log/05.png" alt="언두 테이블스페이스 구조" width="788" height="638" loading="lazy" decoding="async" style="max-width: 450px" />
<figcaption>언두 테이블스페이스 구조</figcaption>
</figure>

하나의 언두 테이블스페이스는 **1~128 개 사이의 롤백 세그먼트**를 가지고, <strong>롤백 세그먼트는 1개 이상의 언두 슬롯(Undo Slot)</strong>을 가진다.

또또 못보던 녀석들이 보인다. <strong>롤백 세그먼트(Rollback Segment)</strong>는 또 뭐고, <strong>언두 슬롯(Undo Slot)</strong>은 또 뭘까?

[**MySQL 공식 문서 : Undo Log**](https://dev.mysql.com/doc/refman/8.0/en/innodb-undo-logs.html) 의 설명을 먼저 보도록 하자.

> **언두 로그 저장 위치**
>
> 언두 로그는 롤백 세그먼트(Rollback Segment) 내의 언두 로그 세그먼트(Undo Log Segment) 내에 존재하며, 롤백 세그먼트는 언두 테이블 스페이스(Undo Tablespace)와 전역 임시 테이블 스페이스(Global Temporary Tablespace)에 존재한다.
>
> **롤백 세그먼트**
>
> 언두 로그를 포함하는 저장소 영역. 롤백 세그먼트는 전통적으로 시스템 테이블스페이스에 존재했다. MySQL 5.6에서는 롤백 세그먼트가 언두 테이블스페이스에 존재할 수 있다. MySQL 5.7에서는 롤백 세그먼트가 글로벌 임시 테이블스페이스에 할당되기도 한다.
>
> **언두 로그 세그먼트**
>
> 언두 로그 모음. 언두 로그 세그먼트는 롤백 세그먼트 내에 존재한다. 언두 로그 세그먼트에는 여러 트랜잭션의 언두 로그가 포함될 수 있다. 언두 로그 세그먼트는 한 번에 하나의 트랜잭션에서만 사용할 수 있지만 트랜잭션 커밋 또는 롤백 시 해제된 후 재사용할 수 있다. "언두 세그먼트"라고도 할 수 있다.

> 🤷🏻‍♂️ **개인적 의문**
>
> 공식 문서를 계속해서 들여다 봐도, 너무 모호하다고 느껴진다.<br>
> 롤백 세그먼트 내에 언두 로그 세그먼트가 존재하고, 언두 슬롯도 존재한다.
>
> 그런데 언두 로그가 언두 로그 세그먼트에 저장된다면, 언두 슬롯은 뭘 위한 공간인지 체감이 되지 않는다.
>
> 이 부분은 좀 더 깊게 들어가볼 생각이다. 일단 지금은 단순히 **언두 세그먼트** 라는게 존재하는구나 정도로만 이해하고 넘어가자.

하나의 트랜잭션이 필요로 하는 언두 슬롯의 개수는 트랜잭션이 실행하는 **INSERT**, **UPDATE**, **DELETE** 문장의 특성에 따라 최대 4개까지 언두 슬롯을 사용한다. 다음과 같은 작업 유형에 대해 각각 하나씩 할당된다.

1. **사용자 정의 테이블에 대한 INSERT 작업**
2. **사용자 정의 테이블에 대한 UPDATE 및 DELETE 작업**
3. 사용자 정의 임시 테이블에 대한 INSERT 작업
4. 사용자 정의 임시 테이블에 대한 UPDATE 및 DELETE 작업

다만 **일반적으로 트랜잭션은 임시 테이블을 사용하지 않기 때문에, 하나의 트랜잭션이 2개의 언두 슬롯(1,2 작업에 대한)을 사용**한다고 가정하면 된다.

> 📌 **참고**
>
> - **사용자 정의 테이블**
>   - `일반적인 테이블`  을 의미한다. 이러한 테이블은 데이터베이스에 저장되며, 여러 세션에서 접근할 수 있다.
> - **사용자 정의 임시 테이블**
>   - `CREATE TEMPORARY TABLE` 문을 사용하여 생성되는 특수한 유형의 테이블  이다.
>   - 임시 테이블은 현재 세션 내에서만 보이며, 세션이 종료될 때 자동으로 삭제된다.

### 3. 언두 테이블스페이스 동적 추가 및 삭제

MySQL 8.0 부터 기본적으로 언두 테이블스페이스 2개가 생성된다. 못믿겠다면 확인해보자.

<figure>
<img src="/images/innodb-redo-undo-log/06.png" alt="기본 설정 언두 테이블스페이스 확인" width="664" height="352" loading="lazy" decoding="async" style="max-width: 450px" />
<figcaption>기본 설정 언두 테이블스페이스 확인</figcaption>
</figure>

**undo_001**, **undo_002** 라는 언두 테이블스페이스 파일이 이미 시스템 상에 존재하는 것을 확인할 수 있다.

MySQL 8.0 버전 이후부터는 기본 언두 테이블스페이스 2개에, 언두 테이블스페이스를 추가 및 삭제할 수 있게 되었다.

```sql
-- // 언두 테이블스페이스 생성
CREATE UNDO TABLESPACE extra_undo_003 ADD DATAFILE '/data/undo_dir/undo_003';

-- // 언두 테이블스페이스 비활성화
ALTER UNDO TABLESPACE extra_undo_003 SET INACTIVE;

-- // 비활성화된 테이블스페이스 삭제
DROP UNDO TABLESPACE extra_undo_003;
```

또한 MySQL 8.0 부터 언두 테이블스페이스의 불필요한 공간을 잘라 운영체제로 반납하는 방법을 제공한다.

이를 **Undo tablespace truncate** 라고 한다. 해당 방법에는 **자동 모드**와 **수동 모드** 두 가지가 존재한다.

1. **자동 모드 : innodb_undo_log_truncate=ON**

InnoDB 스토리지 엔진은 **언두 로그 공간에서 불필요한 언두 로그를 삭제하는 작업**을 실행하기 위해 <strong>퍼지 스레드(Purge Thread)</strong>를 사용한다. 이 작업을 <strong>언두 퍼지(Undo Purge)</strong>라고 한다.

퍼지 스레드는 주기적으로 언두 퍼지를 실행해 언두 로그 파일에서 사용되지 않는 공간을 잘라내 운영체제로 반납한다.

2. **수동 모드 : innodb_undo_log_truncate=OFF**

**언두 테이블스페이스가 최소 3개 이상** 되어야 작동한다.

언두 테이블스페이스를 비활성화해 언두 테이블스페이스가 더이상 사용되지 않도록 설정하면,

퍼지 스레드는 비활성 상태의 언두 테이블스페이스를 찾아 불필요한 공간을 잘라내 운영체제로 반납한다.

비활성 언두 테이블스페이스에 대한 언두 퍼지가 완료되면(반납이 완료되면), 해당 언두 테이블스페이스를 다시 활성화한다.

## 참고 자료

[**MySQL 공식 문서 : Redo Log**](https://dev.mysql.com/doc/refman/8.0/en/innodb-redo-log.html)

[**MySQL 공식 문서 : Undo Log**](https://dev.mysql.com/doc/refman/8.0/en/innodb-undo-logs.html)
