---
title: 'PG 승인 뒤 서버가 죽으면: 결제 중 주문을 PG 조회로 되맞추는 스케줄러, 그리고 구현하지 못한 타임아웃과 재요청 확인'
description: 'PG 승인은 성공했는데 서버가 죽어 주문이 결제 중 상태로 남는 경우를 대비해, 15분 넘게 결제 중인 주문을 PG에 조회해 결제 완료나 취소로 되맞추는 스케줄러를 만들었습니다. Read Timeout과 재요청 시 PG 조회, 웹훅도 함께 검토했지만 구현하지 못했습니다. 글을 쓰며 테스트로 다시 돌려 보니 PG 호출이 타임아웃 같은 예외로 끝난 주문은 결제 대기로 돌아가 이 스케줄러의 대상에서 빠졌고, PG 조회가 실패하면 스케줄러가 끝나지 않고 같은 주문을 계속 조회했습니다.'
pubDate: '2026-01-19'
updatedDate: '2026-09-24'
tags: ['payment', 'reliability', 'scheduler', 'spring', 'kopang']
---

[앞 글](/blog/kopang-payment-expiry-race/)에서 코팡의 결제 요청과 만료 취소 스케줄러의 경합을 다뤘습니다. 이 글은 외부 PG와 통신하는 구간에서 생기는 문제를 다룹니다.
2026-01-16부터 01-19까지 작업했고 [PR #42](https://github.com/kodesalon/kopang/pull/42)로 머지했습니다.

근거는 코드·커밋·이슈이고, 이번(2026-09-24)에 레포를 복제해 검증 테스트를 추가로 돌렸습니다. PG는 테스트용 가짜로 바꿨습니다. 원래 레포에는 이 테스트를 넣지 않았습니다.

## 문제: 돈은 나갔는데 DB는 그대로

결제 흐름은 결제 중 상태로 바꾸고, PG에 승인을 요청하고, 결과에 따라 결제 완료로 확정하는 순서입니다.

```java
// → PAYMENT_IN_PROGRESS
orderService.prepareOrderForPayment(orderNo, amount);
try {
    // PG 승인
    paymentResult = paymentClient.approve(paymentKey, orderNo, amount);
} catch (Exception e) {
    orderService.rollbackToPending(orderNo);  // → PENDING
    throw e;
}
// DONE이면 completePayment(): → PAID, 결제 이력 저장
```

PG 승인이 성공한 직후 서버가 죽거나 스레드가 멈추면, 결제 확정 코드도 `catch` 블록도 실행되지 않습니다. 고객 돈은 나갔는데 주문은 결제 중 상태로 남습니다.
PG 승인은 성공했지만 결제 확정 트랜잭션이 DB 문제로 실패하는 경우도 비슷합니다. 고객은 카드사 결제 알림을 받았는데 앱에는 주문 대기로 보입니다.

## 검토한 대책

이슈 [#41](https://github.com/kodesalon/kopang/issues/41)과 당시 정리에서 대책을 다섯 가지 적었습니다.

| 대책 | 내용 | 구현 |
| --- | --- | --- |
| Read Timeout | PG 호출에 타임아웃을 걸어 무한정 기다리지 않게 함. 외부 지연이 커넥션·스레드 고갈로 번지는 것을 막음 | 안 함 |
| 재요청 시 확인 | 사용자가 다시 결제할 때 주문이 결제 중이면 먼저 PG에 조회. 이미 결제됐으면 완료 처리, 아니면 재결제 진행 | 안 함 |
| 대사 스케줄러 | 결제 중 상태로 15분 넘게 남은 주문을 주기적으로 PG에 조회해 되맞춤 | 함 |
| DB 저장 재시도 | PG 승인 뒤 DB 저장이 실패하면 몇 번 다시 시도 | 안 함 |
| PG 웹훅 | 결제 상태가 바뀌면 PG가 우리 서버로 알림. 알림 유실에 대비해 스케줄러는 여전히 필요 | 보류 |

Read Timeout은 설정할 대상이 없었습니다. `PaymentClient`는 인터페이스이고, 구현체는 `null`을 돌려주는 `MockPaymentClient` 하나뿐입니다. HTTP 클라이언트 자체가 없어서 타임아웃도 없습니다.
재요청 시 확인도 없습니다. 결제 요청은 주문 상태와 상관없이 곧바로 결제 준비와 PG 승인으로 갑니다.

## 구현한 것: 대사 스케줄러

```java
// OrderReconcileScheduler
@Scheduled(fixedDelay = 60_000)
public void reconcileStuckPaymentOrders() {
    while (true) {
        Orders expiredOrders =
            orderService.findExpiredInProgressOrders(LocalDateTime.now());
        if (expiredOrders.isEmpty()) {
            break;
        }
        expiredOrders.forEach(paymentRecoveryOrchestrator::recover);
    }
}

// PaymentRecoveryOrchestrator
public void recover(Order order) {
    Long orderNo = order.getNo();
    try {
        PaymentResult paymentResult = paymentClient.retrieveByOrder(orderNo);
        switch (paymentResult.status()) {
            // → PAID
            case DONE -> paymentService.completePayment(orderNo, paymentResult);
            // 실패 이력 저장, 주문 취소, 재고 복구
            case ABORTED, EXPIRED -> { ... }
            default -> log.error(...);
        }
    } catch (Exception e) {
        log.warn("Reconcile order [{}] 실패. 다음 cycle 에 재시도됩니다.",
                 orderNo);
    }
}
```

1분마다 결제 중 상태로 15분이 지난 주문을 100건씩 가져와 PG에 결제 상태를 묻고, 결제됐으면 완료로, 실패나 만료면 취소하고 재고를 되돌립니다. 한 건이 실패해도 나머지는 계속 처리하도록 건마다 예외를 잡습니다.
서버가 PG 승인 직후 죽은 경우와, PG 승인 뒤 DB 저장이 실패한 경우는 주문이 결제 중 상태로 남으므로 이 스케줄러가 맡습니다.

## 다시 돌려 본 결과

### 타임아웃 같은 예외로 끝난 주문은 스케줄러가 보지 않습니다

PG 호출이 읽기 타임아웃 같은 예외로 끝나는 경우를 흉내 냈습니다.

```
VERIFY v4 thrown = simulated read timeout
VERIFY v4 status after PG exception = PENDING
VERIFY v4 retrieveByOrder calls = 0
```

예외가 나면 `catch` 블록이 주문을 결제 대기로 되돌립니다. 대사 스케줄러는 결제 중 상태만 보므로 이 주문은 대상이 아닙니다. 이 주문은 5분이 지나면 만료 취소 스케줄러가 취소하고 재고를 되돌립니다.
그런데 타임아웃은 "실패"가 아니라 "결과를 모름"입니다. PG 쪽에서는 승인이 끝났을 수 있습니다. 그러면 돈은 나갔는데 주문은 취소되고 재고는 다른 사람에게 팔립니다.

당시 정리의 결론에는 "타임아웃이 났을 때의 문제를 결제 중 주문의 PG 조회로 해결할 수 있다"고 적었지만, 구현된 흐름에서는 타임아웃이 난 주문이 결제 중 상태에 남지 않습니다. 결제 취소 PR([#34](https://github.com/kodesalon/kopang/pull/34))에서 리뷰어가 남긴 "결제 요청이 timeout 처리되었을 때, 손실이 없는지 점검해보면 좋을 것 같아요"라는 코멘트가 이 경우입니다.

### PG 조회가 실패하면 스케줄러가 끝나지 않습니다

결제 중 상태로 20분이 지난 주문을 하나 두고, PG 조회가 계속 실패하게 한 뒤 스케줄러 메서드를 실행했습니다.

```
VERIFY v5 after 2s: reconcile thread alive = true, PG lookups = 22229
VERIFY v5 @Scheduled pool core size = 1
```

2초 동안 같은 주문을 22,229번 조회했고, 메서드는 끝나지 않았습니다.
`recover`가 예외를 잡고 로그만 남기므로 주문은 결제 중 상태 그대로입니다. 그러면 `while (true)`가 같은 주문을 다시 가져오고, 다시 실패하고, 이를 반복합니다. 로그의 "다음 cycle에 재시도"는 실제로는 다음 주기가 아니라 같은 실행 안에서 바로 재시도입니다.
PG가 알 수 없는 상태를 돌려줘 `default` 분기로 가는 경우도 같습니다.

영향은 이 스케줄러에서 끝나지 않습니다. `@Scheduled` 작업이 도는 스레드 풀 크기가 기본값 1이라, 이 메서드가 스레드를 붙잡으면 만료 주문 자동 취소, outbox 재발행, 대기열 처리 스케줄러가 모두 멈춥니다.
PG 장애는 이 스케줄러가 대비하려던 바로 그 상황인데, 그때 스케줄러 전체가 멈추고 PG와 DB에 조회를 쏟아붓게 됩니다.

지금 코드에서는 이 상황이 더 쉽게 생깁니다. `MockPaymentClient.retrieveByOrder`는 `null`을 돌려주므로 조회 결과에서 바로 `NullPointerException`이 나고, 이것도 같은 반복에 들어갑니다. 다만 [앞 글](/blog/kopang-payment-expiry-race/)에서 봤듯이 주문 시각이 비어 있어 대상 주문이 조회되지 않기 때문에, 지금은 반복이 시작되지도 않습니다.

## 고친다면

- 예외로 끝난 PG 호출은 결제 대기로 되돌리지 말고 결제 중 상태로 둡니다. 결과를 모르는 주문을 대사 스케줄러가 맡게 됩니다. 사용자가 다시 결제하면 먼저 PG에 조회하는 재요청 확인이 이때 필요해집니다.
- 한 번 실행에서 같은 주문을 다시 가져오지 않게 합니다. 주문 번호 커서로 한 바퀴만 돌거나, 시도 횟수와 다음 시도 시각을 기록해 다음 주기로 넘깁니다.
- 스케줄러 스레드 풀을 늘리거나 작업마다 분리해, 한 작업이 막혀도 나머지는 돌게 합니다.
- 실제 PG를 붙일 때는 연결·읽기 타임아웃을 명시합니다.

## 다시 확인한 것

| 당시 주장 | 확인 결과 | 근거 |
| --- | --- | --- |
| Read Timeout으로 장애 전파 차단 | 미구현. HTTP 클라이언트가 없음 | `MockPaymentClient`, 전체 소스 검색 |
| 응답 미수신 시 무조건 실패 처리 대신 PG 조회 | 반대로 동작. 예외 시 결제 대기로 되돌리고 PG 조회 없음 | 검증 테스트 v4, `PaymentOrchestrator` |
| 재요청 흐름에 PG 조회 배치 | 미구현 | `PaymentOrchestrator.executePayment` |
| 결제 중 15분 넘은 주문을 스케줄러가 PG 조회로 복구 | 구현됨. 서버가 PG 승인 직후 죽는 경우를 맡음 | [PR #42](https://github.com/kodesalon/kopang/pull/42) |
| 외부 장애에서도 자동 대사로 최종 정합성 확보 | PG 조회 실패 시 스케줄러가 끝나지 않고 다른 스케줄러까지 멈춤 | 검증 테스트 v5 |
