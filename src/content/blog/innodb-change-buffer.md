---
title: '체인지 버퍼 - InnoDB 스토리지 엔진 아키텍처 : In-Memory Structures'
description: '체인지 버퍼 : InnoDB 스토리지 엔진 아키텍처'
pubDate: '2023-07-24'
tags: ['mysql', 'innodb', 'database', 'real-mysql']
series:
  id: real-mysql
  order: 4
  label: '체인지 버퍼'
---

## InnoDB 스토리지 엔진 아키텍처

<figure>
<img src="/images/innodb-change-buffer/01.png" alt="InnoDB Architecture" width="1458" height="1138" loading="lazy" decoding="async" style="max-width: 650px" />
<figcaption>InnoDB Architecture</figcaption>
</figure>

InnoDB 스토리지 엔진은 현재 MySQL의 스토리지 엔진 중 가장 많이 사용된다. InnoDB 는 MySQL 에서 사용할 수 있는 스토리지 엔진 중 거의 유일하게 **레코드 기반의 잠금**을 제공하기 때문에 **높은 동시성 처리**가 가능하며 안정적이고 성능이 뛰어나다.

## 체인지 버퍼 (Change Buffer)

<figure>
<img src="/images/innodb-change-buffer/02.png" alt="Change Buffer" width="1250" height="880" loading="lazy" decoding="async" style="max-width: 500px" />
<figcaption>Change Buffer</figcaption>
</figure>

> <strong>체인지 버퍼(Change Buffer)</strong>는 InnoDB 스토리지 엔진의 **버퍼 풀의 일부**로, 보조 인덱스(세컨더리 인덱스) 페이지에 대한 변경 사항을 캐시하는 특수한 데이터 구조이다. 이러한 변경 사항은 INSERT, UPDATE 또는 DELETE 작업(DML)의 결과일 수 있으며, 해당 페이지가 다른 읽기 작업에 의해 버퍼 풀에 로드될 때 나중에 병합된다.<br>
> 또한 <strong>체인지 버퍼는 `메모리와 디스크에 모두 존재`</strong>한다. 메모리에서는 버퍼 풀의 일부를 차지하고, 디스크에서는 시스템 테이블스페이스의 일부로서 데이터베이스 서버가 종료될 때 인덱스의 변경 사항이 버퍼링 된다.

인덱스를 업데이트하는 작업은 랜덤하게 디스크를 읽는 작업을 수행하는데, 테이블에 인덱스가 많다면 이 작업은 상당히 많은 자원을 소모하게 된다.

만약 변경해야하는 데이터가 버퍼 풀에 없으면, 디스크로부터 읽어와 업데이트를 해야한다. 이때, 디스크로부터 가져온 데이터를 **임시 메모리 공간**인 **체인지 버퍼**에 저장을 해두고 바로 사용자에게 결과를 반환하는 형태로 성능을 향상시킨다.

이렇게 체인지 버퍼에 임시로 저장된 인덱스 레코드 조각은 이후 **백그라운드 스레드**인 **체인지 버퍼 머지 스레드**에 의해 병합된다.

> 📌 **참고**
>
> 1. MySQL 8.0 부터는 **INSERT, DELETE, UPDATE** 로 키를 추가하거나 삭제하는 작업에 대해서도 버퍼링이 될 수 있도록 개선되었다.
>
> 2. **innodb_change_buffering** 시스템 변수를 통해 작업의 종류별로 체인지 버퍼를 활성화, 비활성화 할 수 있다.
>
>    - all : 모든 인덱스 관련 작업에 대해 버퍼링 (inserts + deletes + purges)
>    - none : 버퍼링 안함
>    - inserts : 인덱스에 새로운 아이템을 추가하는 작업만 버퍼링
>    - deletes : 인덱스에서 기존 아이템을 삭제하는 작업만 버퍼링
>    - changes : 인덱스에 추가하고 삭제하는 작업만 버퍼링 (inserts + deletes)
>    - purges : 인덱스 아이템을 영구적으로 삭제하는 작업만 버퍼링 (백그라운드 작업)
>
> 3. 체인지 버퍼는 기본적으로 **버퍼 풀 메모리 공간의 25%** 를 사용하도록 설정되어 있다. 최대 50%까지 사용할 수 있도록 설정할 수 있다.<br>
>    **innodb_change_buffer_max_size** 시스템 변수를 통해 비율을 설정할 수 있다. 예를 들어, INSERT 나 UPDATE 등이 자주 실행되어 체인지 버퍼가 더 많은 공간을 사용해야 하는 경우, 이 비율을 높일 수 있다.
