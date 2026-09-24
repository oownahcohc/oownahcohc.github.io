---
title: '분산 락 없이 선착순 재고 차감하기: Lua 스크립트로 원자적 차감, DB 재고 갱신은 요청 흐름에서 분리'
description: '비관적 락 대신 재고 차감 하나만 Redis Lua 스크립트로 원자적으로 처리했습니다. 그 뒤에서 DB 재고를 락 없이 조회 후 갱신하자 1,000개를 판 뒤 DB 잔고가 841로 남는 갱신 손실이 났고, 원자적 UPDATE로 고친 뒤 결국 DB 재고 차감을 요청 흐름에서 빼고 Redis를 1차 저장소로 삼았습니다. 글을 쓰며 커밋을 다시 따라가 보니 "Redis가 순서를 보장한다"는 당시 설명은 틀렸고, DB 재고를 다시 맞추는 쪽은 아직 구현되지 않았습니다.'
pubDate: '2025-12-31'
updatedDate: '2026-09-24'
tags: ['concurrency', 'redis', 'lua', 'mysql', 'kopang']
---

[앞 글](/blog/kopang-pessimistic-lock-cost/)에서 코팡의 재고를 DB 비관적 락으로 지켰을 때의 비용을 쟀습니다.
재고 1,000개는 정확히 팔렸지만, 락을 쥔 트랜잭션이 상품 조회와 주문 INSERT까지 끌고 가는 동안 커넥션을 기다리는 스레드가 190개 쌓였습니다.

대안으로 Redisson 분산 락을 골랐는데, 리뷰에서 이런 지적을 받았습니다. 락을 Redis로 옮겨도 트랜잭션 전체를 잠그는 구조는 같고, 달라지는 건 락을 얻는 비용뿐이라는 것입니다.
이 글은 그 뒤 일주일 동안 락 범위를 재고 차감 하나로 줄여 간 과정입니다.

근거는 코드와 커밋, [GitHub PR·이슈](https://github.com/kodesalon/kopang)이고 이번에 다시 확인했습니다.
갱신 손실 실험의 수치(DB 잔고 841)는 당시 이슈 [#19](https://github.com/kodesalon/kopang/issues/19) 코멘트에 남긴 기록이고, 다시 재현하지는 않았습니다.

## 방향: 재고 차감만 원자적으로

리뷰 코멘트를 받고 2025-12-21에 정리한 방향은 이랬습니다.

- 락 범위를 줄인다. 트랜잭션 전체가 아니라 재고 차감만 원자적으로 처리한다.
- 재고 차감은 Redis에서 한다.
- DB 재고 차감과 주문 생성은 기존 트랜잭션에서 처리하되, `SELECT ... FOR UPDATE`는 뺀다.
- DB 트랜잭션이 실패하면 Redis 재고를 되돌린다.

## Redis 재고 차감: Lua 스크립트

Redis에서 재고를 줄이는 방법으로 `DECR` 한 번과 Lua 스크립트를 두고 고민했고, Lua 스크립트를 골랐습니다([47e4f4c](https://github.com/kodesalon/kopang/commit/47e4f4c)).

```lua
-- KEYS[1]: 재고 키, ARGV[1]: 차감할 수량
local current_stock = redis.call('get', KEYS[1])
local current_stock_val = tonumber(current_stock)

if not current_stock or current_stock_val <= 0 then
    return -1
end

if current_stock_val - tonumber(ARGV[1]) < 0 then
    return -1
end

return redis.call('DECRBY', KEYS[1], ARGV[1])
```

Redis는 스크립트 하나를 실행하는 동안 다른 명령을 끼워 넣지 않습니다. 그래서 재고를 읽고, 모자라면 거절하고, 충분하면 줄이는 세 단계가 하나의 동작처럼 실행됩니다.

`DECR`만 쓰지 않은 이유는 음수 재고 때문입니다. `DECR`은 조건 없이 값을 줄이므로, 재고가 0인데 요청이 들어오면 -1, -2로 계속 내려갑니다.
애플리케이션이 결과를 보고 "재고 없음" 예외를 던져도 Redis의 값은 이미 음수입니다. 이 상태에서 주문 취소로 재고를 되돌리면 실제 재고와 다른 숫자가 됩니다.
`DECR` 뒤에 결과가 음수면 `INCR`로 되돌리는 방법도 있지만, 품절 이후에 몰려드는 요청마다 명령이 하나씩 더 붙습니다.

리뷰에서 "Lua 스크립트를 굳이 써야 하는가"라는 질문을 받았고([PR #24](https://github.com/kodesalon/kopang/pull/24) 코멘트), 위 이유를 [PR #30](https://github.com/kodesalon/kopang/pull/30)에 정리해 답했습니다.

스크립트를 호출하는 Java 코드에는 경계 오류가 하나 있었습니다. 처음에는 스크립트 결과가 `> 0`일 때만 성공으로 봤는데([95e4ede](https://github.com/kodesalon/kopang/commit/95e4ede)), 그러면 마지막 재고를 차감해 남은 수가 0이 되는 요청이 실패로 판정됩니다.
Redis의 재고는 이미 줄었으므로 1,000개 중 한 개가 팔리지 않고 사라집니다. 다음 날 `>= 0`으로 고쳤습니다([dc0a467](https://github.com/kodesalon/kopang/commit/dc0a467)).

## 2차 시도: DB 재고를 락 없이 갱신했더니 갱신 손실

Redis 뒤의 흐름은 처음에 이렇게 만들었습니다([0eaa1df](https://github.com/kodesalon/kopang/commit/0eaa1df)에서 비관적 락 제거).

```java
// PurchaseFacade: Redis 차감 후 DB 트랜잭션
public ReservationOrderResult reserve(Long memberNo, Long productNo,
                                      Integer count) {
    stockReservationService.decrease(productNo, count);     // Redis Lua
    try {
        return purchaseService.reservation(memberNo, productNo, count);
    } catch (Exception e) {
        stockReservationService.increase(productNo, count); // Redis 보상
        throw e;
    }
}

// StockService: 락 없이 조회 후 계산한 값을 저장
Stock stock = stockRepository.findByProductNo(productNo); // SELECT, 락 없음
Stock decreased = stock.decrease(count);
// UPDATE stock SET quantity = :quantity
stockRepository.updateStock(decreased);
```

충돌이 워낙 많을 것으로 보여 낙관적 락도 걸지 않고 테스트했습니다.
결과는 이슈 #19에 이렇게 남겼습니다. Redis는 정확히 1,000명을 통과시켰는데, 1,000개가 팔린 뒤 0이어야 할 DB 재고가 841이었습니다.
기록에는 이 값 하나만 "841개 등"으로 남아 있고, 실행별 결과는 남아 있지 않습니다.

원인은 갱신 손실입니다. MySQL InnoDB의 기본 격리 수준(REPEATABLE READ)에서 일반 `SELECT`는 락 없이 스냅숏을 읽습니다.
두 트랜잭션이 같은 1,000을 읽고 각자 999를 계산해 `SET quantity = 999`로 쓰면, 차감이 두 번 일어났는데 값은 한 번만 줄어듭니다.
1,000번의 차감 중 159번만 반영된 셈입니다.

Redis가 앞에서 정확히 1,000건만 통과시켰으니 판매 수는 맞았습니다. 틀린 건 DB의 재고 숫자였습니다.

## 3차 시도: 원자적 UPDATE

같은 날 밤 DB 재고 갱신을 조회 후 저장이 아니라 UPDATE 한 문장으로 바꿨습니다([dc0a467](https://github.com/kodesalon/kopang/commit/dc0a467)).

```java
@Modifying
@Query("UPDATE StockJpaEntity s SET s.quantity = s.quantity - :count "
     + "WHERE s.productNo = :productNo")
void updateDecreaseStock(Long productNo, Integer count);
```

UPDATE는 스냅숏이 아니라 최신 행을 읽고, 그 행에 배타 락을 건 상태에서 값을 계산합니다. 두 트랜잭션이 동시에 와도 뒤의 것은 앞의 커밋을 기다렸다가 줄어든 값에서 다시 뺍니다. 그래서 갱신 손실이 생기지 않습니다.

두 가지는 짚어 둡니다. 이 쿼리에는 `quantity >= :count` 같은 하한 조건이 없어서, DB 쪽에서 음수를 막는 장치는 없고 Redis가 앞에서 거르는 것에 기댑니다.
그리고 행 락은 UPDATE 순간부터 트랜잭션이 끝날 때까지 유지되므로, 뒤의 주문 INSERT까지는 여전히 같은 행을 잡고 있습니다. 다만 Redis가 재고 수만큼만 요청을 통과시키므로 DB 행을 두고 경쟁하는 요청 수 자체가 줄어듭니다.

당시 기록에는 "성능과 정합성 모두 확보"라고 적었지만, 이 단계에서 잰 수치는 남아 있지 않습니다. 이 글에서도 효과를 숫자로 적지는 않겠습니다.

## 남은 질문 두 개

이 구조를 확정하려다 두 가지가 걸렸습니다.

첫째, 원자적 UPDATE가 정합성을 보장한다면 Redis는 왜 필요한가.
정합성만 보면 DB로 충분합니다. Redis의 역할은 품절 이후의 요청을 DB에 닿기 전에 거르는 것입니다. 재고 1,000개에 요청 수십만 건이 오면, 나머지 요청이 전부 DB UPDATE 락을 두고 경쟁하는 상황을 막아 줍니다.

둘째, 창고가 여러 개가 되면 어떻게 하는가.
다음 단계에는 "가까운 창고에 재고가 없으면 다음 창고에서 차감"하는 요구사항이 있었습니다. 이런 조건 분기는 UPDATE 한 문장으로 표현하기 어렵고, 애플리케이션에서 읽고 판단하고 쓰는 방식으로 돌아가면 동시성 문제가 다시 생깁니다.
Lua 스크립트 안에 분기를 넣는 방법도 떠올렸지만, 핵심 비즈니스 규칙을 Redis 스크립트에 두는 게 맞는지 확신이 없었습니다.

## 결정: DB 재고 차감을 요청 흐름에서 뺐습니다

2025-12-28에 방향을 정했습니다. 요청을 처리하는 동안에는 DB 재고를 건드리지 않고, Redis를 재고의 1차 저장소로 삼습니다([2d4c592](https://github.com/kodesalon/kopang/commit/2d4c592), [b368f7c](https://github.com/kodesalon/kopang/commit/b368f7c)).

```java
// PurchaseFacade (2025-12-28)
public ReservationOrderResult reserve(Long memberNo, Long productNo,
                                      Integer count) {
    // Redis Lua
    Stock stockVO = stockReservationService.decrease(productNo, count);
    try {
        // DB: 주문 INSERT만
        Order order =
            orderService.createOrderPending(memberNo, productNo, count);
        return new ReservationOrderResult(stockVO, order);
    } catch (Exception e) {
        stockReservationService.increase(productNo, count);  // Redis 보상
        throw e;
    }
}
```

DB 재고 차감과 주문 생성을 묶던 `PurchaseService`는 지웠습니다. 요청 경로에서 DB가 하는 일은 주문 INSERT 하나가 됐고, DB의 재고 숫자는 나중에 따로 맞추기로 했습니다(Eventual Consistency).
이 변경은 2025-12-31에 main에 들어갔습니다([PR #24](https://github.com/kodesalon/kopang/pull/24)).

두 번째 질문(창고 여러 개)에는 2026년 1월에 이렇게 답했습니다. 분기는 Java에 두고, 창고마다 Redis 키를 따로 두어 가까운 창고부터 Lua 차감을 차례로 시도합니다.
창고 하나에 대한 차감은 여전히 원자적이고, 처음 성공한 창고에서 멈춥니다.

```java
// PurchaseOrchestrator (2026-01)
for (Warehouse warehouse : warehouses) {   // 회원 주소와 가까운 순
    // 창고별 Lua 차감
    Optional<StockQuantity> sq =
        stockReservationService.decrease(warehouse.getNo(), productNo, count);
    if (sq.isPresent()) {
        finalStock = sq.get();
        allocatedWarehouse = warehouse;
        break;
    }
}
```

## 아직 남은 것

이 구조로 락 대기는 사라졌지만, 해결하지 못한 문제가 있습니다.

1. Redis 차감은 DB 트랜잭션 밖에서 일어납니다. Redis에서 재고를 줄인 뒤 주문 INSERT가 커밋되기 전에 프로세스가 죽으면, 보상 코드가 실행되지 않아 Redis 재고만 줄어든 채 남습니다. 초과 판매가 아니라 덜 파는 쪽으로 틀어집니다.
2. DB의 `stock.quantity`는 요청 흐름에서 더 이상 갱신되지 않습니다. 이 숫자를 메시지 큐로 맞추려고 Outbox 테이블까지는 만들었지만, 메시지를 보내는 쪽은 아직 빈 구현이고 소비하는 쪽은 없습니다. 이 과정은 [Eventual Consistency 글](/blog/kopang-ec-sync-options/)에서 이어서 다룹니다.
3. Redis는 순서를 보장하지 않습니다. 당시 이슈에는 "Redis가 앞단에서 트래픽을 막고 순서를 보장한다"고 적었는데, 틀린 설명이었습니다. Lua 스크립트가 보장하는 것은 원자성(초과 판매 없음)이지 도착 순서가 아닙니다. 2026년 3월에 50명 동시 요청으로 재 보니, 요청을 보낸 순서와 주문 번호 순서가 뒤바뀐 쌍이 1,225쌍 중 378쌍(30.9%)이었습니다([PR #56](https://github.com/kodesalon/kopang/pull/56)). Tomcat 스레드가 요청을 집어 드는 순서부터 도착 순서와 다르기 때문입니다.
4. Redis 장애는 다루지 않았습니다. Redis 복제는 비동기라, 차감 직후 복제 전에 주 노드가 죽으면 그 차감이 사라질 수 있습니다. 재고의 1차 저장소가 Redis인 이상 이 위험은 그대로 남습니다.

이 전환으로 응답 시간이 얼마나 줄었는지는 당시 원자료를 찾지 못해 이 글에서 다루지 않았습니다.

## 다시 확인한 것

| 당시 주장 | 확인 결과 | 근거 |
| --- | --- | --- |
| 1차 시도로 Redis 분산 락과 낙관적 락 적용 | 구현하지 않은 설계안. 리뷰 후 철회 | 이슈 #19 코멘트(2025-12-19, 12-21) |
| Lua 스크립트로 원자적 차감, 음수 재고 방지 | 맞음 | [47e4f4c](https://github.com/kodesalon/kopang/commit/47e4f4c), PR #30 |
| 락 없이 조회 후 갱신하자 DB 잔고 841 | 코드 구조는 확인. 수치는 당시 기록이며 재현 안 함 | [0eaa1df](https://github.com/kodesalon/kopang/commit/0eaa1df), 이슈 #19 코멘트(2025-12-23) |
| 원자적 UPDATE로 해결, 성능과 정합성 모두 확보 | 코드는 확인. 성능·정합성 수치는 남아 있지 않음 | [dc0a467](https://github.com/kodesalon/kopang/commit/dc0a467) |
| Redis가 앞단에서 순서를 보장 | 틀림. 원자성만 보장하고 순서는 30.9% 역전 | PR #56 |
| Redis를 1차 저장소로, DB는 나중에 맞춤 | 요청 흐름 변경은 맞음. DB 재고를 맞추는 쪽은 미구현 | [2d4c592](https://github.com/kodesalon/kopang/commit/2d4c592), `MockKafkaMessageProducer` |
