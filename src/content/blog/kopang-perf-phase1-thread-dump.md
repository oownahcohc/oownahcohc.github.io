---
title: '선착순 주문 1차 부하 테스트 병목 분석: CPU는 남는데 p95가 3.29초인 원인을 스레드 덤프로 찾기'
description: '재고 차감을 Redis로 옮겨 락 대기를 없앤 뒤, 이제 병목이 어디인지 보려고 부하 테스트를 다시 걸었습니다. 성능 테스트 연작의 첫 글로, 테스트 설계부터 스레드 덤프로 병목을 찾기까지를 정리합니다.'
pubDate: '2026-01-29T13:00:00+09:00'
updatedDate: '2026-09-24'
tags: ['load-test', 'performance', 'hikaricp', 'spring', 'kopang']
series:
  id: kopang
  order: 9
  label: '성능: 1차 부하 테스트에서 스레드 덤프로 병목 찾기'
---

코팡은 재고 차감을 Redis Lua 스크립트로 옮기면서 DB 비관적 락을 걷어냈습니다([관련 글](/blog/kopang-redis-lua-stock/)).
락 대기는 사라졌는데, 그렇다면 이제 병목은 어디일까를 보려고 2026-01-29 저녁에 부하 테스트를 다시 걸었습니다. 이 글은 성능 테스트 연작의 첫 번째입니다.

근거는 두 종류입니다. 테스트 시점의 코드는 커밋으로 다시 확인했습니다. k6 출력과 모니터링·스레드 덤프 수치는 당시 기록을 옮겼고, 테스트는 다시 돌리지 않았습니다.

## 테스트 설계

선착순은 조회 위주의 일반 커머스 트래픽과 모양이 다릅니다. 짧은 순간에 많은 사용자가 같은 상품 하나를 두고 경쟁합니다. 그래서 k6로 짧게 몰아치는 스파이크 테스트를 짰습니다.

```js
// k6/performance-test.js (요지)
scenarios: {
    warm_up: { executor: 'constant-vus', vus: 10, duration: '30s' },
    fcfs_spike: {
        executor: 'ramping-vus', startTime: '35s',
        stages: [
            { target: 300, duration: '5s' },   // 5초 만에 300 VU
            { target: 300, duration: '2m' },   // 2분 유지
            { target: 0, duration: '10s' },
        ],
    },
},
thresholds: { http_req_duration: ['p(95)<1000'] },

// 회원 번호는 1~20,000을 돌려 가며 사용
const memberNo = (exec.scenario.iterationInTest % 20000) + 1;
```

| 구분 | 값 |
| --- | --- |
| 앱 서버 | EC2 t3.small 1대 (2 vCPU, 2GB) |
| DB | RDS MySQL db.t4g.micro 1대 |
| Tomcat 스레드 / Hikari 풀 | 기본값 200 / 10 |
| 캐시 | 없음 |

두 가지를 먼저 적어 둡니다. 첫째, 재고를 넉넉히 넣어서 모든 요청이 주문에 성공하는 경로만 쟀습니다. 품절 이후 요청이 Redis에서 바로 거절되는 경로는 이 숫자에 들어 있지 않습니다.
둘째, 같은 회원 번호가 여러 번 주문합니다. 한 사람이 한 번 주문하는 실제 선착순과 달라서, 뒤의 캐시 단계에서 적중률이 실제보다 높게 나오는 원인이 됩니다.

## 결과

```
http_req_duration: avg=1.87s min=44.48ms med=2.1s max=6.88s
                   p(90)=3.07s p(95)=3.29s
http_req_failed:   0.00%  0 out of 20663
http_reqs:         20663  121.535619/s
```

| 지표 | 값 |
| --- | --- |
| 처리량 | 121.5 TPS |
| 평균 응답 | 1.87초 |
| p95 | 3.29초 (목표 1초 미달) |
| 실패 | 0건 |

당시 정리한 요약표에는 평균 응답이 1.02초로 적혀 있었는데, k6 원본 출력은 1.87초입니다. 이 글에서는 원본 값을 썼습니다.

## 모니터링 지표

| 지표 | 관찰 |
| --- | --- |
| CPU | 시작 직후 98%까지 치솟았다가, 부하 유지 구간에서는 30~60%, 평균 32% |
| Load Average | 평균 1 안팎, 최대 1.8 (2 vCPU) |
| JVM 스레드 | timed-waiting 약 200개, runnable 20개 미만 |
| Hikari | active 10, pending 약 190 |
| 응답 시간 그래프 | 약 1.5초 부근에서 평평해짐 |

CPU는 남는데 스레드 대부분이 기다리고 있었습니다. Tomcat 스레드 200개 중 10개만 커넥션을 쥐고, 나머지 190개는 커넥션을 얻으려고 줄을 서 있었습니다(200 − 10 = 190).
계산이 모자란 게 아니라 I/O를 기다리는 상태였습니다.

## 스레드 덤프: 어디서 기다리나

누가 커넥션을 기다리는지 보려고 스레드 덤프를 떴습니다. timed-waiting 스레드 약 190개의 스택은 세 곳으로 나뉘었습니다.

| 대기 위치 | 스레드 수 | 하는 일 |
| --- | --- | --- |
| `createOrderPending` | 96 | 주문 트랜잭션 시작 시 커넥션 획득 |
| `findWarehousesForProduct` | 51 | 상품이 있는 창고 목록 조회 |
| `findDefaultByMemberNo` | 43 | 회원 기본 배송지 조회 |

테스트 시점 코드([0af15fb](https://github.com/kodesalon/kopang/commit/0af15fb))로 요청 한 건의 DB 작업을 따라가 보면 이렇습니다.

1. 회원 기본 배송지 조회 (SELECT)
2. 상품이 있는 창고 목록 조회 (SELECT)
3. 가까운 창고부터 Redis Lua로 재고 차감
4. 트랜잭션 안에서 상품 조회(SELECT), 주문 INSERT, outbox INSERT

요청 한 건이 조회만 세 번 커넥션을 빌리고, 매번 풀 10개를 두고 경쟁합니다. 캐시는 하나도 켜져 있지 않았습니다(창고 조회의 `@Cacheable`은 주석 처리 상태).
배송지·창고·상품은 주문 중에 거의 바뀌지 않는 데이터인데, 이 조회들이 정작 중요한 쓰기 트랜잭션과 같은 풀을 두고 다투고 있었습니다.

## 다음 단계

두 가지를 정했습니다.

- 캐시: 반복되는 조회를 메모리로 옮겨 커넥션을 빌리는 횟수와 시간을 줄인다.
- 풀 재조정: 처리 시간이 줄어든 뒤, 리틀의 법칙(동시 처리 수 = 처리량 × 처리 시간)을 기준으로 Tomcat 스레드와 Hikari 풀 크기를 다시 정한다.

캐시를 어떻게 나눠 적용했는지는 [다음 글](/blog/kopang-perf-phase2-cache/)에 적었습니다.

## 다시 확인한 것

| 당시 주장 | 확인 결과 | 근거 |
| --- | --- | --- |
| 121.5 TPS, p95 3.29초 | 맞음 | 당시 k6 출력 |
| 평균 응답 1.02초 | 틀림. k6 원본은 1.87초 | 당시 k6 출력 |
| 요청 한 건에 DB 조회가 최소 세 번 | 맞음. 캐시가 모두 꺼진 상태 | [0af15fb](https://github.com/kodesalon/kopang/commit/0af15fb) 시점 `PurchaseOrchestrator`, `OrderService` |
| Tomcat 200 / Hikari 10 기본값 | 맞음. 테스트 직전 커밋에서 설정을 주석 처리해 기본값이 됨 | [c85c23a](https://github.com/kodesalon/kopang/commit/c85c23a) |
| 테스트가 선착순 상황을 재현 | 부분적. 성공 경로만 쟀고, 같은 회원이 반복 주문 | `k6/performance-test.js` |
