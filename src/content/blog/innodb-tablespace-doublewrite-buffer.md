---
title: '테이블 스페이스와 Double Write Buffer - InnoDB 스토리지 엔진 아키텍처 : On-Disk Structures'
description: '테이블 스페이스와 이중 쓰기 버퍼 : InnoDB 스토리지 엔진 아키텍처'
pubDate: '2023-07-25'
tags: ['mysql', 'innodb', 'database', 'real-mysql']
series:
  id: real-mysql
  order: 5
  label: '테이블 스페이스와 Double Write Buffer'
---

## InnoDB 스토리지 엔진 아키텍처

<figure>
<img src="/images/innodb-tablespace-doublewrite-buffer/01.png" alt="InnoDB Architecture" width="1458" height="1138" loading="lazy" decoding="async" style="max-width: 650px" />
<figcaption>InnoDB Architecture</figcaption>
</figure>

InnoDB 스토리지 엔진은 현재 MySQL의 스토리지 엔진 중 가장 많이 사용된다. InnoDB 는 MySQL 에서 사용할 수 있는 스토리지 엔진 중 거의 유일하게 **레코드 기반의 잠금**을 제공하기 때문에 **높은 동시성 처리**가 가능하며 안정적이고 성능이 뛰어나다.

### 테이블 스페이스 (Tablespace)

> InnoDB 스토리지 엔진에서 테이블을 생성할 때, 테이블 데이터와 인덱스 데이터를 저장할 위치를 지정할 수 있다. 이러한 위치를 <strong>테이블 스페이스(Tablespace)</strong>라고 한다.

InnoDB 스토리지 엔진은 다섯 가지 유형의 테이블 스페이스를 제공하는데, 다음과 같다.

1. **시스템 테이블 스페이스(System Tablespace)**
2. **일반 테이블 스페이스(General Tablespace)**
3. **파일 당 테이블 스페이스(File-Per-Table Tablespace)**
4. **언두 테이블 스페이스(Undo Tablespace)**
5. **임시 테이블 스페이스(Temporary Tablespace)**

이번 글에서는 **시스템 테이블 스페이스**, **일반 테이블 스페이스**, **파일 당 테이블 스페이스** 를 간략하게 살펴보도록 하겠다.

더욱 자세한 내용은 [**MySQL 공식문서 : Tablespace**](https://dev.mysql.com/doc/refman/8.0/en/innodb-tablespace.html) 에서 확인할 수 있다.

#### 1. 시스템 테이블 스페이스 (System Tablespace) : 공유 테이블 스페이스

<figure>
<img src="/images/innodb-tablespace-doublewrite-buffer/02.png" alt="시스템 테이블 스페이스" width="354" height="174" loading="lazy" decoding="async" style="max-width: 350px" />
<figcaption>시스템 테이블 스페이스</figcaption>
</figure>

1. <strong>시스템 테이블 스페이스(System Tablespace)</strong>는 [**체인지 버퍼 (Change Buffer)**](/blog/innodb-change-buffer/)를 위한 저장 공간이다.
2. File-Per Table Tablespace 또는 General Tablespace가 아닌 **시스템 테이블스페이스에 테이블이 생성되는 경우**, **테이블 및 인덱스 데이터를 포함**할 수도 있다.
3. 버전에 따라 상이하지만, **MySQL 8.0.20 이전 버전**에서는 **DoubleWrite 버퍼의 저장 공간도 시스템 테이블 스페이스에 존재**한다.

체인지 버퍼에서 봤던 내용을 상기해보자. 체인지 버퍼는 메모리와 디스크 두 군데에 모두 존재한다.

메모리에서는 버퍼 풀의 일부를 차지하고, **디스크에서는 시스템 테이블스페이스의 일부로서 데이터베이스 서버가 종료될 때 인덱스의 변경 사항이 버퍼링** 된다.

**MySQL 8.0 이전 버전**에서는 **시스템 테이블스페이스가 InnoDB 데이터 딕셔너리를 포함**했다.

**MySQL 8.0 이후 버전**에서 InnoDB는 MySQL 데이터 딕셔너리에 메타데이터를 저장한다.

**MySQL 8.0.20 이전 버전**에서는 **DoubleWrite 버퍼 저장 영역이 InnoDB 시스템 테이블스페이스에 위치**해 있다.

**MySQL 8.0.20 이후 버전**에서는 **DoubleWrite 버퍼 저장 영역이 DoubleWrite 파일에 위치**해 있다.

시스템 테이블스페이스에는 하나 이상의 데이터 파일이 있을 수 있다. 기본적으로 **ibdata1** 이라는 이름의 단일 시스템 테이블스페이스 데이터 파일이 데이터 디렉토리에 생성된다. 시스템 테이블스페이스 데이터 파일의 크기와 수는 **innodb_data_file_path** 시스템 변수에 의해 정의된다.

#### 2. 일반 테이블 스페이스 (General Tablespace) : 공유 테이블 스페이스

<figure>
<img src="/images/innodb-tablespace-doublewrite-buffer/03.png" alt="일반 테이블 스페이스" width="308" height="280" loading="lazy" decoding="async" style="max-width: 350px" />
<figcaption>일반 테이블 스페이스</figcaption>
</figure>

> <strong>일반 테이블스페이스(General Tablespace)</strong>는 **CREATE TABLESPACE 구문**을 사용하여 생성되는 공유 InnoDB 테이블스페이스이다.<br>
> <strong>시스템 테이블 스페이스(System Tablespace)</strong>와 유사하게 <strong>일반 테이블 스페이스(General Tablespace)</strong>는 **여러 테이블에 대한 데이터를 저장할 수 있는 공유 테이블 스페이스**이다.

General Tablespace는 File-Per-Table Tablespace에 비해 잠재적인 메모리 이점이 있다. 데이터베이스 서버는 테이블스페이스의 수명 동안 테이블스페이스 메타데이터를 메모리에 저장한다. 여러 개의 테이블이 별도의 File-Per-Table Tablespace보다 적은 수의 General Tablespace에 있으면, 테이블 스페이스 메타데이터에 대한 메모리 사용량이 더 적다.

예를 들어, 10개의 테이블이 각각 별도의 파일별 테이블 스페이스에 있으면, 각 테이블 스페이스에 대한 메타데이터가 각각의 메모리에 저장된다. 반면, 10개의 테이블이 하나의 일반 테이블 스페이스에 있으면, 하나의 테이블 스페이스에 대한 메타데이터만 메모리에 저장된다.

따라서 여러 개의 테이블이 일반 테이블 스페이스에 있으면, 별도의 파일별 테이블 스페이스에 있을 때보다 메모리 사용량이 더 적다.

#### 3. 파일 당 테이블 스페이스 (File-Per-Table Tablespace) : 단일 테이블 스페이스

> **파일 당 테이블 스페이스(File-Per Tablespace**)에는 단일 InnoDB 테이블에 대한 데이터 및 인덱스가 포함되며, 파일 시스템에 단일 데이터 파일로 저장된다.<br>
> 테이블 생성 InnoDB는 **기본적으로** 해당 테이블의 데이터와 인덱스 데이터를 **파일 당 테이블 스페이스(File-Per-Table Tablespace) 에 저장**한다.

파일 당 테이블 스페이스는 각 테이블마다 별도의 데이터 파일을 생성하여 데이터와 인덱스 데이터를 저장한다. **innodb_file_per_table** 시스템 변수를 통해 이를 제어할 수 있다.

**innodb_file_per_table=ON** 으로 설정하면 InnoDB는 InnoDB 테이블당 하나의 테이블스페이스 파일을 사용한다. 이렇게 함으로써, 각 테이블의 데이터 관리가 용이해지며, 디스크 공간 활용도가 개선된다. 예를 들어, 테이블을 삭제하면 해당 테이블의 데이터가 저장된 디스크 공간도 자동으로 해제된다.

**innodb_file_per_table=OFF** 로 설정하면 InnoDB는 모든 테이블을 InnoDB **시스템 테이블 스페이스**에 저장한다. 이 경우에는, 테이블을 삭제하면 해당 테이블의 데이터가 저장된 디스크의 공간을 수동으로 해제해야 한다.

### Double Write Buffer

> <strong>더블 라이트 버퍼(Double Write Buffer)</strong>는 더티 페이지를 InnoDB의 디스크 파일의 적절한 위치에 기록하기 전에 버퍼 풀에서 플러시된 페이지를 기록하는 저장 영역이다.

하드웨어의 오작동이나 시스템의 비정상 종료와 같은 문제로 **페이지의 일부만 기록되는 현상**인 **파셜 페이지(Partial-page)** 또는 <strong>톤 페이지(Torn-page)</strong>가 발생할 수 있다.

이는 InnoDB 스토리지 엔진의 리두 로그가 리두 로그 공간의 낭비를 막기 위해 페이지의 변경된 내용만 기록하는 특징 때문에 발생한다.

만약 InnoDB 스토리지 엔진에서 더티 페이지를 디스크 파일로 플러시할 때 시스템 비정상 종료와 같은 문제로 일부만 기록된다면 해당 페이지의 내용은 복구할 수 없게 된다.

이와 같은 문제를 막기 위해 사용하는 것이 바로 **Double-Write** 기법이다. 다음 그림과 함께 어떻게 작동하는지 한번 살펴보도록 하자.

<figure>
<img src="/images/innodb-tablespace-doublewrite-buffer/04.png" alt="Double-Write 작동 방식 - 출처 [Real MySQL 8.0 1권]" width="924" height="766" loading="lazy" decoding="async" style="max-width: 450px" />
<figcaption>Double-Write 작동 방식 - 출처 [Real MySQL 8.0 1권]</figcaption>
</figure>

1. 버퍼 풀에 존재하는 **A, B, C, D, E** 다섯 개의 더티 페이지를 디스크로 플러시 하고자 한다.
2. **A, B, C, D, E** 다섯 개의 더티 페이지를 묶어서 한 번의 디스크 쓰기로 시스템 테이블스페이스의 DoubleWrite 버퍼에 기록한다. (MySQL 8.0.20 버전 이하)
3. InnoDB 스토리지 엔진은 각 더티 페이지를 디스크 파일의 적당한 위치에 하나씩 랜덤으로 쓰기를 실행한다.

시스템 테이블스페이스의 DoubleWrite 버퍼 공간에 기록된 변경 내용은, 실제 데이터 파일에 더티 페이지들이 정상적으로 기록되면 더이상 필요가 없어진다. 위에서 말했듯이, DoubleWrite 버퍼의 내용은 실제 데이터 파일 쓰기가 여러가지 이유들로 비정상 종료되어 중간에 실패할 때만 사용된다.

만약 더티 페이지를 기록하는 도중에 운영체제가 비정상 종료된다면, InnoDB 스토리지 엔진은 재시작될 때 항상 DoubleWrite 버퍼의 내용과 데이터 파일의 페이지들을 모두 비교해 다른 내용을 담고 있는 페이지가 존재한다면 DoubleWrite 버퍼의 내용을 데이터 파일의 페이지로 복사한다.

DoubleWrite 기능의 사용 여부는 **innodb_doublewrite**  시스템 변수로 제어할 수 있고, 확장자는 **.dblwr** 를 사용한다.

## 참고자료

[**MySQL 공식문서 : Tablespace**](https://dev.mysql.com/doc/refman/8.0/en/innodb-tablespace.html)
