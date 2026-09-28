---
title: '결제 확정과 만료 취소의 경합 대응: PAYMENT_IN_PROGRESS와 상태별 만료 시간, 조건부 UPDATE를 걷어내며 잃은 것'
description: '결제 기한이 지난 주문은 스케줄러가 취소하는데, 결제 요청과 만료 취소가 같은 주문을 동시에 건드릴 수 있습니다. 이 경합을 주문 상태와 만료 시간으로 푼 과정과, 그 풀이가 막지 못한 경우를 테스트로 다시 확인합니다.'
pubDate: '2026-01-29T11:00:00+09:00'
updatedDate: '2026-09-24'
tags: ['payment', 'concurrency', 'scheduler', 'spring', 'kopang']
series:
  id: kopang
  order: 7
  label: '결제: 결제 확정과 만료 취소의 경합 대응'
---

코팡에서 선착순 재고를 확보한 주문은 결제 대기(`PENDING`) 상태로 만들어지고, 사용자는 5분 안에 결제해야 합니다. 5분 안에 결제하지 않은 주문은 스케줄러가 취소하고 Redis 재고를 되돌립니다.
이 글은 결제 요청과 만료 취소가 같은 주문을 동시에 건드릴 때의 문제를 다룬 기록입니다. 2025-12-29부터 2026-01-09까지의 작업입니다.

근거는 코드·커밋·PR이고, 이번(2026-09-24)에 레포를 복제해 검증 테스트를 추가로 돌렸습니다. 원래 레포에는 이 테스트를 넣지 않았습니다.

## 결제 흐름

```java
// PaymentOrchestrator
public Payment executePayment(String paymentKey, Long orderNo,
                              BigDecimal amount, Long productNo,
                              Integer count) {
    // PENDING → PAYMENT_IN_PROGRESS
    orderService.prepareOrderForPayment(orderNo, amount);

    PaymentResult paymentResult;
    try {
        // PG 승인, 트랜잭션 밖
        paymentResult = paymentClient.approve(paymentKey, orderNo, amount);
    } catch (Exception e) {
        // 사용자가 다시 시도할 수 있게 PENDING으로
        orderService.rollbackToPending(orderNo);
        throw e;
    }

    switch (paymentResult.status()) {
        // → PAID, 결제 이력 저장
        case DONE -> {
            return paymentService.completePayment(orderNo, paymentResult);
        }
        case ABORTED -> { /* 실패 이력 저장, PENDING으로 되돌림 */ }
        case EXPIRED -> { /* 실패 이력 저장, 주문 취소, 재고 복구 */ }
        // ...
    }
}
```

PG 호출은 DB 트랜잭션 밖에서 합니다. 외부 호출이 느려져도 DB 커넥션을 붙잡지 않게 하려는 것입니다.

## 결제 중 상태를 따로 둔 이유

처음 주문 상태는 `PENDING`, `PAID`, `CANCELLED` 세 개였습니다. 2025-12-29에 `PAYMENT_IN_PROGRESS`를 추가했고 이유는 두 가지였습니다.

첫째, 중복 결제 요청(따닥)을 막기 위해서입니다. 상태가 `PENDING`뿐이면 요청 A와 B가 동시에 `PENDING`을 확인하고 둘 다 PG에 결제를 요청할 수 있습니다.
결제 중 상태가 있으면 상태 변경 자체를 락처럼 쓸 수 있습니다.

```sql
UPDATE orders SET status = 'PAYMENT_IN_PROGRESS'
 WHERE no = ? AND status = 'PENDING'
```

A가 먼저 바꾸면 B의 UPDATE는 조건이 맞지 않아 0건이 되고, B는 결제를 진행하지 않습니다.

JPA의 `@Version` 낙관적 락 대신 이 방식을 고른 이유도 적어 두었습니다. 충돌은 예외 상황이 아니라 흔히 일어나는 흐름이라 예외를 던지고 잡기보다 영향받은 행 수(0 또는 1)로 분기하는 편이 자연스럽고, 상태 값 자체가 버전 역할을 하므로 컬럼을 따로 둘 필요가 없다는 판단이었습니다.

둘째, 두 상태의 의미가 달라서 만료 정책을 다르게 가져갈 수 있습니다.

| 상태 | 의미 | 만료 |
| --- | --- | --- |
| `PENDING` | 주문은 했지만 결제를 시작하지 않음 | 5분. 재고를 빨리 회수 |
| `PAYMENT_IN_PROGRESS` | 결제를 시작했지만 결과를 모름 | 15분. PG 지연을 고려해 여유 있게 |

## 스케줄러와의 경합

만료 주문을 취소하는 스케줄러가 30초마다 돕니다. 처음에는 두 상태 모두 5분이 지나면 취소하는 정책이었는데, 이러면 이런 경우가 생깁니다.

1. 사용자가 4분 59초에 결제를 누르고 `PAYMENT_IN_PROGRESS`로 들어간다.
2. 5분 00초에 스케줄러가 주문을 취소하고 재고를 되돌린다.
3. 5분 02초에 PG 승인이 돌아와 결제를 확정하려 한다.

스케줄러가 이기면 재고는 회수됐는데 돈은 나간 상태가 됩니다. 이를 되돌리려면 자동 환불을 해야 하는데, 사용자에게 가장 나쁜 경험이라고 봤습니다.

## 결정: 만료 시간을 나누고, 조건부 UPDATE는 걷어냈다

선착순은 재고 회전이 중요하니 만료 주문을 최대한 빨리 취소해야 한다고 생각했었습니다. 하지만 몇 초의 회수 지연이 시스템을 복잡하게 만들 만큼 치명적이지는 않다고 판단을 바꿨습니다.

2026-01-08에 두 가지를 바꿨습니다.

- 스케줄러가 `PENDING` 주문을 고르는 기준을 "5분 지남"에서 "5분 5초 지남"으로 늦췄습니다([15f11bb](https://github.com/kodesalon/kopang/commit/15f11bb)). 사용자는 5분까지만 결제를 시작할 수 있으므로, 두 쪽이 같은 주문을 건드리는 시간대가 5초 벌어집니다.
- `PAYMENT_IN_PROGRESS`의 만료를 15분으로 따로 두었습니다([8f06344](https://github.com/kodesalon/kopang/commit/8f06344)). 정상적인 결제는 그 안에 끝나므로 스케줄러와 만나지 않습니다.

두 쪽이 시간상 만나지 않는다고 보고, 같은 날 조건부 UPDATE 메서드를 모두 지웠습니다([5905c55](https://github.com/kodesalon/kopang/commit/5905c55), [b01cda5](https://github.com/kodesalon/kopang/commit/b01cda5) 외). 지금 상태 변경은 조건 없이 주문 번호로만 UPDATE합니다.

```java
// 지운 것 (2025-12-29 ~ 2026-01-08)
@Query("UPDATE OrderJpaEntity o SET o.status = :status "
     + "WHERE o.no = :orderNo AND o.status = 'PENDING'")
int updateStatusToInProgress(Long orderNo, OrderStatus status);

// 남은 것
@Query("UPDATE OrderJpaEntity o SET o.status = :status WHERE o.no = :orderNo")
void updateOrder(Long orderNo, OrderStatus status);
```

덧붙이면, 지운 조건부 UPDATE도 반환값(영향받은 행 수)을 확인하는 코드는 아직 없었습니다([PR #25](https://github.com/kodesalon/kopang/pull/25) 본문에 "아직 적용은 안 해 둔 상태"라고 적혀 있습니다).

## 다시 돌려 본 결과

앱과 같은 설정(`@SpringBootTest`, test 프로필, H2)에서 PG 클라이언트만 테스트용 가짜로 바꿔 돌렸습니다.

### 주문 시각이 비어 있어 만료 로직이 돌지 않습니다

```
VERIFY v1 prepare threw NullPointerException, ordered_at=null
```

주문을 만들고 바로 결제를 준비하면 `NullPointerException`이 납니다. 만료를 검사하는 `orderedAt.plusMinutes(5)`에서 주문 시각이 null이기 때문입니다.
주문 시각 필드는 2025-12-20 리팩터링([5b238b1](https://github.com/kodesalon/kopang/commit/5b238b1))에서 Hibernate의 `@CreationTimestamp`가 Spring Data의 `@CreatedDate`로 바뀌었는데, `@CreatedDate`를 채우는 `@EnableJpaAuditing`은 어느 브랜치에도 없습니다.
그래서 이 글의 만료 로직(자동 취소 01-06, 결제 전 만료 검사 01-08)은 만들어진 뒤로 실제 주문 시각을 가지고 돈 적이 없습니다. 만료 주문을 찾는 조회도 0건이었습니다. 이 기능들에는 자동화 테스트가 없어서 드러나지 않았습니다.
운영 DB 컬럼에 기본값이 있었는지는 확인하지 못했습니다. 다만 JPA가 null을 명시해 INSERT하므로 기본값이 있어도 적용되지 않았을 가능성이 큽니다.

이하 테스트는 주문 시각을 직접 채워 넣고 진행했습니다.

### 결제 도중 두 번째 요청이 들어오면 PG를 두 번 부릅니다

첫 결제 요청이 PG 응답을 기다리는 동안 같은 주문에 두 번째 결제 요청을 보냈습니다.

```
VERIFY v2 status while first request waits on PG = PAYMENT_IN_PROGRESS
VERIFY v2 approve calls = 2
VERIFY v2 first result = IllegalStateException:
                          결제 진행 중인 주문만 승인할 수 있습니다.
VERIFY v2 second result = Payment(ok)
VERIFY v2 final status = PAID,
       payments rows = [{PAYMENT_KEY=key-B, STATUS=DONE}]
```

두 번째 요청은 막히지 않았고 PG 승인이 두 번 호출됐습니다. 뒤의 요청이 먼저 결제를 확정했고, 먼저 들어간 요청은 PG 승인까지 받은 뒤 확정 단계에서 실패했습니다. DB에는 결제 한 건만 남았습니다.

원인은 두 가지입니다. 조건부 UPDATE가 없어졌고, 도메인의 결제 준비 검증은 `PAID`와 `CANCELLED`만 막고 `PAYMENT_IN_PROGRESS`는 통과시킵니다.
만료 시간 분리는 사용자와 스케줄러의 경합을 다룬 것이지 사용자 요청끼리의 경합을 다룬 것이 아니었습니다. 조건부 UPDATE를 지우면서 "결제 중 상태를 둔 첫째 이유"였던 중복 결제 방어가 함께 사라졌습니다.
실제로 돈이 두 번 나가는지는 PG에 달려 있습니다. 같은 결제 키로 두 번 승인을 요청하면 PG가 두 번째를 거절하는 경우가 많지만, 서버 쪽에서는 막는 장치가 없습니다.

### 5초 버퍼는 경합을 없애지 않고 좁힙니다

스케줄러의 일괄 취소와 사용자의 상태 변경이 겹치는 순서를 손으로 재현했습니다. 사용자 요청이 4분 59초에 주문을 읽고 검증을 통과한 뒤, UPDATE 전에 스케줄러가 먼저 취소하는 순서입니다.

```
VERIFY v3 after scheduler cancel = CANCELLED,
          after stale user update = PAYMENT_IN_PROGRESS
```

취소된 주문이 결제 중 상태로 되살아났습니다. 실제 흐름이었다면 재고는 이미 Redis로 돌아간 뒤입니다.
이 순서가 실제로 생기려면 사용자 쪽 트랜잭션이 검증과 UPDATE 사이에서 5초 이상 멈춰야 하므로(GC 정지, 락 대기 등) 흔하지는 않습니다. 그래도 당시 적은 "동시성 이슈를 근본적으로 제거했다"는 표현은 맞지 않고, "경합이 생길 수 있는 시간대를 크게 좁혔다"가 정확합니다.
스케줄러의 일괄 취소 쿼리가 `PENDING`뿐 아니라 `PAYMENT_IN_PROGRESS`도 취소 대상으로 허용한다는 점도 이 경우를 넓힙니다([OrderRepositoryImpl](https://github.com/kodesalon/kopang/blob/main/src/main/java/com/kodesalon/kopang/storage/order/OrderRepositoryImpl.java)).

### 테스트하지 않았지만 코드에서 보이는 것

- 서버가 두 대 이상이면 스케줄러가 서버마다 돕니다. 분산 락이 없고, 일괄 취소 뒤 재고 복구는 실제로 취소된 행 수와 상관없이 조회한 주문 전부에 대해 Redis 재고를 늘립니다. 두 서버가 같은 주문을 동시에 처리하면 재고가 두 번 늘어납니다.
- `PAYMENT_IN_PROGRESS`의 15분은 결제를 시작한 시각이 아니라 주문 시각부터 셉니다. 결제는 주문 후 5분 안에만 시작할 수 있으므로, 결제를 시작한 뒤 스케줄러가 볼 때까지는 적어도 10분이 남습니다.

## 고친다면

- 상태를 조건으로 거는 UPDATE를 되살리고 영향받은 행 수를 확인합니다. 결제 준비는 `PENDING`일 때만, 결제 확정은 `PAYMENT_IN_PROGRESS`일 때만 바뀌게 하면 사용자끼리의 경합과 스케줄러와의 경합을 모두 DB가 가릅니다. 만료 시간 분리는 그 위에서 충돌 빈도를 줄이는 장치로 남기면 됩니다.
- `@EnableJpaAuditing`을 켜고, 만료 로직에 주문 시각이 들어간 통합 테스트를 둡니다.
- 서버를 늘린다면 스케줄러에 분산 락을 걸고, 재고 복구는 실제로 취소된 주문에 대해서만 합니다.

## 다시 확인한 것

| 당시 주장 | 확인 결과 | 근거 |
| --- | --- | --- |
| `PAYMENT_IN_PROGRESS`와 조건부 UPDATE로 중복 결제 방어 | 조건부 UPDATE는 01-08에 삭제. 지금은 두 번째 요청도 PG 승인까지 감 | 검증 테스트 v2, [5905c55](https://github.com/kodesalon/kopang/commit/5905c55) |
| 상태별 만료 시간(5분+5초, 15분) | 코드에 있음 | `Order.calculatePendingCutoffTime`, `calculateInProgressCutoffTime` |
| 만료 시간 분리로 동시성 이슈를 근본적으로 제거 | 경합 시간대를 좁힘. 상태 조건 없는 UPDATE라 겹치면 취소가 덮임 | 검증 테스트 v3 |
| 복잡한 동시성 제어 없이 결제 정합성 보장 | 성립하지 않음 | 검증 테스트 v1~v3 |
| 만료 주문 자동 취소 | 주문 시각이 null이라 대상 0건, 결제 준비는 NPE | 검증 테스트 v1, [5b238b1](https://github.com/kodesalon/kopang/commit/5b238b1) |
