---
title: '요청당 DB 조회 세 번을 캐시로 줄이기: 회원 배송지는 Redis, 창고·상품은 Caffeine으로 나눠 TPS 121에서 221로'
description: '1차 부하 테스트에서 찾은 요청당 DB 조회 세 번을 캐시로 옮겼습니다. 회원마다 다른 배송지는 서버 간에 공유되는 Redis에, 모두가 같이 쓰고 거의 바뀌지 않는 창고·상품은 서버 메모리의 Caffeine에 두고 Hikari 풀을 10에서 30으로 늘렸더니, 처리량이 121에서 221 TPS로, 중위 응답이 2.10초에서 0.36초로 줄었습니다. 글을 쓰며 코드와 대조해 보니 테스트 후반 GC 급증을 설명한 부분은 실제 코드와 맞지 않아 원인을 확인되지 않은 것으로 고쳤습니다.'
pubDate: '2026-01-30'
updatedDate: '2026-09-24'
tags: ['load-test', 'performance', 'cache', 'redis', 'kopang']
---

[1차 테스트](/blog/kopang-perf-phase1-thread-dump/)에서 코팡의 주문 요청 한 건이 배송지·창고·상품을 각각 DB에서 조회하고, 그 조회들이 쓰기 트랜잭션과 같은 커넥션 풀 10개를 두고 다툰다는 것을 찾았습니다.
2026-01-30 새벽에 캐시와 풀 크기를 바꾸고 같은 테스트를 다시 돌렸습니다.

근거는 커밋([ee5731a](https://github.com/kodesalon/kopang/commit/ee5731a)부터 [2e99afe](https://github.com/kodesalon/kopang/commit/2e99afe)까지)과 당시 기록입니다. 테스트는 다시 돌리지 않았습니다.

## 캐시를 어디에 둘까

조회 세 개를 성격에 따라 나눴습니다.

| 데이터 | 성격 | 저장 위치 | 이유 |
| --- | --- | --- | --- |
| 회원 기본 배송지 | 회원마다 다름, 가짓수가 많음 | Redis (공유 캐시) | 서버가 여러 대면 같은 회원 요청이 같은 서버로 온다는 보장이 없음. 서버마다 따로 들고 있으면 메모리가 중복되고 적중률도 떨어짐 |
| 상품이 있는 창고 목록 | 모두가 같이 씀, 가짓수가 적음, 이벤트 중 거의 안 바뀜 | Caffeine (서버 메모리) | 네트워크 왕복과 직렬화 비용이 없음. 바뀔 일이 드물어 TTL만으로 충분 |
| 상품 정보 | 인기 상품 몇 개에 몰림, 이벤트 중 사실상 상수 | Caffeine (서버 메모리) | 위와 같음 |

```java
@Cacheable(cacheManager = Caches.Manager.REDIS,
           value = Caches.Name.MEMBER_ADDRESS, key = "#memberNo")
public Address getDefaultMemberAddress(Long memberNo) { ... }

@Cacheable(cacheManager = Caches.Manager.CAFFEINE,
           value = Caches.Name.PRODUCT_WAREHOUSES, key = "#productNo")
public Warehouses getWarehousesForProduct(Long productNo) { ... }

@Cacheable(cacheManager = Caches.Manager.CAFFEINE,
           value = Caches.Name.PRODUCT, key = "#productNo")
public Product getProduct(Long productNo) { ... }
```

상품 조회는 원래 주문 트랜잭션 안에 있었는데, 캐시를 거치도록 트랜잭션 밖으로 옮겼습니다. 이제 트랜잭션 안에서는 주문 INSERT와 outbox INSERT만 합니다.

Redis 캐시에 도메인 객체를 JSON으로 넣는 과정에서 역직렬화 오류를 몇 번 겪었습니다. Java record와 생성자 매핑 문제였고, 타입 정보를 record에도 붙이는 설정으로 정리했습니다([cae9c30](https://github.com/kodesalon/kopang/commit/cae9c30), [5e83bba](https://github.com/kodesalon/kopang/commit/5e83bba)).

## 풀 크기 조정

| 설정 | 1차 | 2차 | 이유 |
| --- | --- | --- | --- |
| Hikari 최대 커넥션 | 10 | 30 | 1차에서 커넥션을 쥐고 일하는 시간(usage)은 약 25ms, 커넥션을 기다리는 시간(acquire)은 약 400ms였음. 커넥션을 늘리면 동시에 처리하는 양이 늘 것으로 봄 |
| Tomcat 최대 스레드 | 200 | 100 | 캐시로 DB 대기가 줄면 더 적은 스레드로 같은 양을 처리할 수 있다고 봄. 스레드가 너무 많으면 문맥 전환 비용만 늘어남 |

## 결과

| 지표 | 1차 | 2차 | 변화 |
| --- | --- | --- | --- |
| 처리량 | 121.5 TPS | 221.1 TPS | 82% 증가 |
| 중위 응답 | 2.10초 | 0.36초 | 83% 감소 |
| p95 | 3.29초 | 2.21초 | 33% 감소 |
| 최소 응답 | 45ms | 18ms | 60% 감소 |

대부분의 요청은 2초대에서 0.3초대로 내려왔습니다. p95는 여전히 목표(1초)를 넘었습니다.

## 지표를 보니 아직 커넥션이 병목

| 지표 | 1차 | 2차 |
| --- | --- | --- |
| JVM 스레드 timed-waiting | 약 200 | 약 80 |
| JVM 스레드 runnable | 20개 미만 | 약 40 |
| Hikari active / pending | 10 / 약 190 | 30 / 약 69 |
| Load Average 최대 (2 vCPU) | 1.8 | 5.4 |

조회를 캐시로 빼자 실제로 일하는 스레드가 늘었고, 그만큼 CPU 경합도 생겼습니다(Load Average 5.4).
그래도 Tomcat 스레드 100개 중 30개만 커넥션을 쥐고 나머지 70개 가까이는 여전히 기다렸습니다(100 − 30 = 70, 관찰값 69). 남은 DB 작업은 주문 INSERT와 outbox INSERT라서, 이 쓰기가 이제 병목이 됐습니다.

## 테스트 후반의 CPU·GC 급증은 원인을 확인하지 못했습니다

테스트가 끝나 가는 02:15:30 무렵 CPU와 Load Average가 다시 초반 수준으로 치솟았고, 같은 시점에 비동기 이벤트 스레드 처리량, JVM 메모리 할당 속도(최대 144MiB/s), GC 횟수(초당 1.8회)와 GC 정지 시간이 함께 올랐습니다.

당시에는 원인을 이렇게 설명했습니다. 주문 커밋 뒤에 도는 Kafka 발행 리스너(`@Async` + `AFTER_COMMIT`)가 이벤트를 메시지로 바꿔 보내는데, 커밋 전까지 대기하던 비동기 작업들이 커밋과 함께 한꺼번에 풀리면서 객체 할당과 GC가 몰렸다는 설명입니다.

이번에 코드와 대조해 보니 이 설명은 맞지 않았습니다.

- 당시 글에 인용한 `kafkaMessageProducer.produce(event.toMessage())`는 레포에 없습니다. 실제 코드는 인자 없는 `produce()`이고 본문이 비어 있습니다([MockKafkaMessageProducer](https://github.com/kodesalon/kopang/blob/main/src/main/java/com/kodesalon/kopang/infra/messaging/kafka/MockKafkaMessageProducer.java)). 전체 브랜치 이력에도 `toMessage`는 없습니다.
- `AFTER_COMMIT` 리스너는 트랜잭션마다 그 트랜잭션이 커밋된 직후에 비동기 작업을 하나씩 넘깁니다. 여러 요청의 작업이 쌓여 있다가 어느 순간 한꺼번에 풀리는 구조가 아닙니다.

빈 메서드를 부르는 비동기 작업이 초당 수백 건 도는 정도로 144MiB/s의 할당이 생긴다고 보기는 어렵습니다. 급증은 실제로 있었지만, 원인은 확인하지 못한 상태로 남겨 둡니다.

## 같은 테스트를 한 번 더 돌렸더니

병목을 더 자세히 보려고 스레드 덤프를 뜨면서 같은 테스트를 한 번 더 돌렸습니다. 코드와 설정은 그대로였는데 결과가 크게 달랐습니다.

```
http_req_duration: avg=251.41ms med=267.21ms max=1.03s
                   p(90)=321.7ms p(95)=341.17ms
http_reqs:         149995  882.209693/s
```

처리량이 221에서 882 TPS로 4배가 됐습니다. 이 차이가 어디서 왔는지는 [다음 글](/blog/kopang-perf-jit-warmup/)에서 다룹니다.

## 다시 확인한 것

| 당시 주장 | 확인 결과 | 근거 |
| --- | --- | --- |
| 배송지는 Redis, 창고·상품은 Caffeine | 맞음 | [8d0c848](https://github.com/kodesalon/kopang/commit/8d0c848), [46b5f16](https://github.com/kodesalon/kopang/commit/46b5f16), [ebc540f](https://github.com/kodesalon/kopang/commit/ebc540f) |
| Tomcat 100 / Hikari 30 | 맞음 | [2e99afe](https://github.com/kodesalon/kopang/commit/2e99afe) |
| 121.5 → 221.1 TPS, p95 3.29 → 2.21초 | 당시 기록과 일치. 재측정 안 함 | 당시 k6 출력 |
| 후반 GC 급증은 Kafka 발행 비동기 작업이 커밋 시점에 몰려서 | 코드와 맞지 않음. 발행은 빈 메서드이고 `toMessage`는 없음. 원인 미확인 | `MockKafkaMessageProducer`, 전체 브랜치 `git log -S toMessage` 결과 없음 |
