---
title: '재고 동기화용 메시지 큐 고르기: RabbitMQ, Kafka, Redis Streams를 비교해 Redis Streams를 고른 이유'
description: 'Redis 재고를 DB에 반영할 메시지 큐 후보로 RabbitMQ, Kafka, Redis Streams를 비교했습니다. 이미 쓰고 있는 Redis 안에서 Lua 스크립트로 재고 차감과 이벤트 기록을 한 번에 처리할 수 있다는 점 때문에 Redis Streams를 골랐고, 이 결정은 3주 뒤 뒤집혔습니다. 글을 쓰며 비교표를 공식 문서와 대조해 보니, RabbitMQ Streams를 빠뜨렸고 처리량 수치는 벤더 벤치마크였습니다.'
pubDate: '2026-01-02'
updatedDate: '2026-09-24'
tags: ['eventual-consistency', 'redis', 'kafka', 'rabbitmq', 'kopang']
---

[앞 글](/blog/kopang-ec-sync-options/)에서 코팡의 Redis 재고를 DB에 맞추는 방법으로 메시지 큐를 고르기로 했습니다.
이 글은 어떤 메시지 큐를 쓸지 비교한 기록입니다. 이슈 [#31](https://github.com/kodesalon/kopang/issues/31)을 연 2026-01-02와 최종 결정을 올린 01-28 사이에 정리했는데, 정확한 날짜는 남아 있지 않습니다.
이 단계도 설계만 했고, Redis Streams를 쓰는 코드는 전체 브랜치 어디에도 없습니다.

## 당시 그린 흐름

요청 처리를 동기 구간과 비동기 구간으로 나눴습니다.

- 동기 구간: 사용자가 주문하면 API 서버가 Redis에서 재고를 확인하고 바로 줄인다. 성공하면 주문 정보를 담은 이벤트를 메시지 큐에 발행한다.
- 비동기 구간: 메시지 큐가 이벤트를 저장한다. 별도의 소비자가 이를 읽어 DB의 재고 테이블과 주문 이력 테이블에 반영한다.

이 그림에서는 주문 INSERT까지 소비자가 맡습니다. 실제 코드는 그렇게 가지 않았습니다. 주문은 지금도 요청 중에 동기로 INSERT하고, 메시지로 넘기려던 것은 재고 숫자뿐입니다.

## 후보 비교

### RabbitMQ

AMQP를 구현한 메시지 브로커입니다. 브로커가 exchange와 routing key로 어느 큐에 보낼지 정하고, 소비자에게 메시지를 밀어 넣는(push) 방식이 기본입니다.
일반 큐는 소비자가 처리를 확인(ack)하면 메시지를 지웁니다. 메시지가 비어 있을 때 지연이 매우 짧아 알림처럼 즉시성이 중요한 곳에 맞습니다.

당시 정리에는 "소비된 메시지는 삭제되므로 다시 처리하려면 별도 보관이 필요하다"고 적었습니다. 일반 큐에 대해서는 맞지만, RabbitMQ에는 소비해도 지우지 않고 여러 번 다시 읽을 수 있는 [Streams](https://www.rabbitmq.com/docs/streams)라는 큐 종류도 있습니다. 당시 비교에서는 이를 빠뜨렸습니다.

### Kafka

디스크에 순서대로 쌓는 로그(append-only log)를 중심으로 한 분산 스트리밍 플랫폼입니다. 브로커는 기록만 하고, 어디까지 읽었는지(offset)는 소비자가 관리합니다.
메시지는 소비된 뒤에도 보존 기간 동안 남으므로, 소비자 로직에 버그가 있었다면 offset을 되돌려 다시 처리할 수 있습니다.
소비자가 필요한 만큼 가져오는(pull) 방식이고, `max.poll.records`로 한 번에 수백 건을 받아 JDBC 배치로 DB에 넣기 좋습니다.

처리량 근거로 "Kafka 605 MB/s, RabbitMQ 38 MB/s"라는 수치를 인용했습니다. 이 값은 [Confluent가 직접 공개한 벤치마크](https://www.confluent.io/blog/kafka-fastest-messaging-system/)(AWS i3en.2xlarge 인스턴스 기준)입니다. 같은 벤치마크에서 RabbitMQ는 낮은 부하에서 지연이 약 1ms로 가장 짧았습니다.
벤더가 자기 제품을 잰 결과이고, 코팡에서 직접 잰 값은 아닙니다. 게다가 코팡의 부하 테스트 처리량은 가장 높았을 때도 초당 1,000건이 안 됐으므로(당시 기록 996 TPS), 두 브로커 모두 이 차이가 병목이 될 규모가 아니었습니다.

### Redis Streams

Redis 5.0에 들어온 append-only 로그 자료구조입니다. Kafka처럼 소비자 그룹을 지원해 여러 워커가 메시지를 나눠 처리할 수 있고, `XREADGROUP`으로 필요한 만큼 가져가며, 처리 중 실패한 메시지는 PEL(Pending Entries List)로 추적합니다.
모든 연산이 메모리에서 일어나서 빠르고, `COUNT` 옵션으로 여러 건을 한 번에 읽을 수 있습니다.

가장 끌렸던 점은 원자성이었습니다. 재고 키와 스트림이 같은 Redis 안에 있으니, 재고 차감(`DECRBY`)과 이벤트 기록(`XADD`)을 Lua 스크립트 하나에 넣으면 둘이 함께 실행됩니다.
Redis 차감과 메시지 발행이 서로 다른 시스템에 나뉘는 문제가 구조적으로 사라지는 셈입니다.

| 구분 | RabbitMQ (일반 큐) | Kafka | Redis Streams |
| --- | --- | --- | --- |
| 저장 | 메모리·디스크, ack 후 삭제 | 디스크 로그, 보존 기간 동안 유지 | 메모리 (기본은 주기적 RDB 스냅숏, AOF를 켜면 쓰기마다 기록) |
| 전달 방식 | 브로커가 push | 소비자가 pull | 소비자가 pull (`XREADGROUP`) |
| 다시 처리 | 일반 큐는 어려움 (Streams 큐는 가능) | offset을 되돌려 가능 | ID 기준으로 다시 읽기 가능 |
| 재고 차감과 원자적으로 묶기 | 불가 (다른 시스템) | 불가 (다른 시스템) | Lua 스크립트로 가능 |
| 추가 운영 부담 | 브로커 운영 | 브로커 클러스터 운영 | 이미 쓰는 Redis 재사용 |

## 결정: Redis Streams

당시 결론은 Redis Streams였습니다. 이유는 두 가지였습니다.

- 이미 재고의 1차 저장소로 Redis를 쓰고 있어서 인프라를 늘리지 않아도 됩니다.
- Lua 스크립트로 재고 차감과 이벤트 기록을 원자적으로 처리할 수 있습니다.

다른 두 후보를 뺀 이유도 적어 두었습니다.

- Kafka: 지금 요구사항에 비해 구축·운영 비용이 크고, Redis 차감과 Kafka 발행 사이의 정합성을 맞추려면 별도의 복잡한 패턴이 필요합니다.
- RabbitMQ: 순간적으로 큐에 메시지가 쌓일 때 성능이 떨어질 수 있고, 소비된 메시지는 다시 처리하기 어렵습니다.

## 이 결정은 3주 뒤 뒤집혔습니다

2026-01-28에 최종안으로 올린 것은 Redis Streams가 아니라 Kafka와 Transactional Outbox 조합이었습니다.
뒤집힌 이유는 Redis Streams의 강점으로 꼽았던 "같은 Redis 안에 있다"는 점에서 나왔습니다. 재고 이벤트까지 메모리에 두면 Redis 장애나 메모리 부족이 이벤트 유실로 바로 이어진다는 점입니다.
그 사이에 Lua 스크립트의 원자성이 정확히 무엇을 보장하는지 따져 본 과정은 [다음 글](/blog/kopang-lua-atomicity-limits/)에, 최종 결정은 [마지막 글](/blog/kopang-transactional-outbox/)에 적었습니다.

## 다시 확인한 것

| 당시 주장 | 확인 결과 | 근거 |
| --- | --- | --- |
| 동기 구간에서 이벤트 발행, 주문 이력은 소비자가 DB에 반영 | 실제 코드와 다름. 주문은 요청 중 동기 INSERT | `OrderService.createOrderPending` |
| RabbitMQ는 소비된 메시지를 다시 처리할 수 없음 | 일반 큐만 해당. Streams 큐는 반복 읽기 가능 | RabbitMQ Streams 문서 |
| Kafka 605 MB/s, RabbitMQ 38 MB/s | Confluent 자체 벤치마크 수치. 직접 측정 아님 | Confluent 블로그 |
| Redis Streams와 Lua로 재고 차감·이벤트 기록을 원자적으로 | Redis 안에서는 맞음. 영속성과 장애 조치는 별개 문제 | Redis 스크립트 문서, 다음 글 |
| Redis Streams 선정 | 설계 단계 결정. 코드 없음. 01-28에 철회 | 전체 브랜치 `git log -S XADD` 결과 없음, 이슈 #31 코멘트 |
