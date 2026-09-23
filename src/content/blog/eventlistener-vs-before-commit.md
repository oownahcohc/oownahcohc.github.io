---
title: '결과가 같은데 왜 @EventListener인가'
description: '카운터 갱신 리스너에 @TransactionalEventListener(BEFORE_COMMIT)이 아니라 @EventListener를 쓴 이유. 원자성이 같아도 고르지 않은 근거와, 그럼 왜 직접 호출이 아닌지까지 정리합니다.'
pubDate: '2026-09-09'
tags: ['spring', 'transaction', 'event']
---

게시글의 `comment_count`를 유지하는 리스너가 있습니다.

```kotlin
@Component
class ContentInteractionCounterListener(
    private val postPort: PostPort,
    private val counterPort: ContentInteractionCounterPort,
) {
    @EventListener
    fun on(event: ContentCommentCreated) =
        apply(event.contentType, event.contentId, commentDelta = 1L)
}
```

그런데 같은 이벤트를 알림 리스너도 듣습니다. 그쪽은 `@TransactionalEventListener(AFTER_COMMIT)`입니다.
**같은 이벤트인데 애노테이션이 다릅니다.** 왜 그런지가 이 글의 주제입니다.

## 1단계. 알림과 카운터는 성격이 반대입니다

| | 카운터 | 알림 |
| --- | --- | --- |
| 정체 | 원본 쓰기의 **일부** | 커밋된 사실의 **부수효과** |
| 불변식 | `comment_count == 실제 댓글 수` | 없음 (best-effort) |
| 실패하면 | **같이 롤백돼야 함** | 삼키고 로그만 남김 |

`post.comment_count`는 "댓글을 썼다"의 파생이 아니라 **같은 사실의 두 번째 표현**입니다.
댓글 INSERT와 같은 원자 단위에 있어야 하니, 커밋 이후에 도는 `AFTER_COMMIT`은 여기서 탈락입니다.

> `AFTER_COMMIT`은 이미 커밋이 끝난 뒤에 돌기 때문에, `REQUIRES_NEW` 없이 쓴 UPDATE는
> 커밋할 트랜잭션이 없어 **조용히 사라집니다.** 붙이면 이번엔 별도 트랜잭션이라
> 실패했을 때 카운트 드리프트가 영구히 남습니다.

여기까지는 흔한 이야기입니다. 진짜 질문은 그다음입니다.

## 2단계. 그런데 `BEFORE_COMMIT`은요?

`TransactionPhase`는 네 개입니다. `AFTER_ROLLBACK`과 `AFTER_COMPLETION`은 애초에 후보가 아니니,
실질 경쟁자는 **`BEFORE_COMMIT` 하나**입니다.

그리고 이건 앞의 반박이 통하지 않습니다.

```kotlin
@TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
fun on(event: ContentCommentCreated) { /* ... */ }
```

- 트랜잭션 **안에서** 돕니다 → UPDATE가 커밋됩니다
- 콜백이 예외를 던지면 롤백됩니다

**원자성만 놓고 보면 `@EventListener`와 결과가 같습니다.** 그럼에도 고르지 않은 이유는 셋입니다.

## 근거 ①. 트랜잭션이 없으면 이벤트가 통째로 사라집니다

`@TransactionalEventListener`는 phase와 무관하게 `TransactionSynchronizationManager`에
콜백을 등록하는 방식으로 동작합니다. 동기화가 활성이 아니면 **리스너가 등록조차 되지 않고
이벤트는 조용히 버려집니다.** `fallbackExecution = true`를 켜지 않는 한 그렇습니다.

즉 이 애노테이션을 다는 순간 카운터는 이런 전제를 갖게 됩니다.

> 이 이벤트를 발행하는 쪽은 반드시 트랜잭션 안이어야 한다.

지금은 발행 지점이 전부 `@Transactional`이라 성립합니다.
문제는 **깨질 때 조용하다**는 것입니다. 나중에 배치나 어드민 경로가 트랜잭션 없이 발행하면
카운트만 빠지고 예외도 로그도 남지 않습니다. 원인을 찾는 데 며칠이 걸리는 종류의 고장입니다.

`@EventListener`는 트랜잭션이 있으면 그 안에서, 없으면 자기 auto-commit으로 **어쨌든 실행됩니다.**
카운터가 굳이 걸 이유가 없는 조건을 안 거는 쪽입니다.

## 근거 ②. `BEFORE_COMMIT`이 파는 가치가 이 코드엔 없습니다

`BEFORE_COMMIT`의 존재 이유는 **"메서드 본문이 다 끝난 뒤, 커밋 직전에 몰아서"** 라는 지연입니다.
그게 이득이 되려면 발행 지점과 메서드 끝 사이에 뭔가가 있어야 합니다.

그런데 발행 지점이 전부 마지막 줄입니다.

```kotlin
@Transactional
fun createComment(command: CreateContentCommentCommand): String {
    // ...
    contentCommentPort.save(comment)
    contentEventPublisher.publishCreated(comment)   // ← 그다음은 return
    return comment.id
}
```

반응 서비스도 마찬가지로 각 분기의 마지막이 `publishEvent`입니다.
**이미 커밋 직전이라 미룰 구간이 없습니다.**
인기 게시글 행의 락 보유 시간을 줄이는 이득조차 실질적으로 생기지 않습니다.
얻는 것 없이 근거 ①의 전제만 늘어납니다.

## 근거 ③. 실패 지점이 원인 코드에서 떨어집니다

`@EventListener`면 카운터 UPDATE가 터졌을 때 스택트레이스가
`createComment` → `publishCreated` → 리스너로 그대로 이어집니다.

`BEFORE_COMMIT`이면 예외가 **트랜잭션 매니저의 커밋 처리 중**에 터집니다.
어느 발행이 원인이었는지가 스택에서 사라집니다.
한 트랜잭션에서 이벤트를 여러 개 쏘는 경로 — 반응 타입 교체는 `Deleted` + `Created` 두 발입니다 —
에서는 더 그렇습니다.

## 결론: 상위집합을 고를 이유가 없습니다

`BEFORE_COMMIT`은 **`@EventListener`와 동작이 같으면서 제약만 하나 더 붙는 상위집합**이었습니다.

더 근본적으로는 이렇습니다.

> `@TransactionalEventListener`는 통째로
> **"리스너 실행 시점을 발행 시점에서 떼어내는"** 도구입니다.
> 그런데 카운터가 원하는 건 정확히 반대 — **직접 메서드 호출과 구별되지 않는 것**입니다.

여기서 이벤트를 쓴 이유는 타이밍이 아니었습니다.
런타임 의미론은 `postPort.incrementCommentCount(...)`를 직접 부르는 것과 완전히 같습니다.

**타이밍을 바꿀 이유가 없다면, 타이밍을 바꾸는 애노테이션을 쓰지 않습니다.**

## 남는 질문: 그럼 그냥 직접 부르면 되지 않나요?

여기까지 읽으면 자연스러운 반문이 하나 남습니다.
어차피 동기이고 같은 트랜잭션이면, 서비스에서 카운터를 그냥 직접 부르면 되지 않나?

정직하게 말하면 **카운터만 놓고 보면 직접 호출이 더 단순합니다.**

- `ContentReactionService`는 이미 `PostPort`를 주입받고 있습니다. 투표 글인지 판정하는 데 쓰거든요.
  직접 부른다고 **새로 늘어나는 의존이 없습니다.**
- `when(contentType)` 분기가 중복된다는 것도 근거가 못 됩니다.
  애노테이션만 뗀 컴포넌트로 추출해서 주입하면 그만입니다.

흔히 대는 "결합도" 논거는 여기서 생각보다 약합니다.

### 그런데 카운터만 놓고 볼 수가 없습니다

`ContentCommentCreated`의 소비자는 셋이고, **트랜잭션 계약이 서로 다릅니다.**

| 소비자 | 계약 | 직접 호출로 대체 가능? |
| --- | --- | --- |
| 콘텐츠 카운터 | 같은 TX · 동기 | 가능 |
| 답글 카운터 | 같은 TX · 동기 | 가능 |
| 알림 | **AFTER_COMMIT** · 별도 TX · 실패 격리 | **불가능** |

세 번째가 핵심입니다. "커밋된 뒤에 실행"은 직접 메서드 호출로 표현할 방법이 없습니다.
`TransactionSynchronization`을 손으로 등록하는 길이 있긴 하지만,
그게 정확히 `@TransactionalEventListener`가 대신 해주는 일입니다.

> **이벤트는 카운터 때문에 도입된 게 아닙니다. 알림 때문에 이미 존재해야 했습니다.**

이게 답입니다. 이벤트가 이미 거기 있는 상태에서 카운터만 직접 호출로 빠지면,
얻는 게 아니라 잃습니다.

### 쪼개면 같은 사실을 두 번 쓰게 됩니다

알림은 여전히 이벤트가 필요하니 `publishEvent`는 **그대로 남습니다.** 거기에 직접 호출이 얹힙니다.

```kotlin
// 지금 — 사실을 한 번 선언합니다
eventPublisher.publishEvent(reactionCreated(command, now))

// 직접 호출 — 같은 사실을 두 번 씁니다
counterUpdater.apply(command.contentType, command.contentId, reactionDelta = 1L)
eventPublisher.publishEvent(reactionCreated(command, now))
```

`publishEvent` 호출이 열 곳이 넘습니다. 그게 전부 두 줄이 되고,
**그 둘은 영원히 손으로 맞춰야 합니다.**

특히 위험한 건 반응 타입 교체입니다.
`LIKE → BAD` 는 반응한 사람 수가 변하지 않으니 카운트도 그대로여야 하는데,
그 보장은 **그 분기에서 이벤트를 발행하지 않는다**는 사실 하나로 성립합니다.
발행이 한 곳이라 규칙도 한 곳입니다.

두 경로로 쪼개면 한쪽만 고쳐도 컴파일이 통과합니다.
새 반응 경로를 추가하면서 `publishEvent`만 쓰고 카운터 호출을 빠뜨리는 사고가 정확히 여기서 납니다.

### 대가도 있습니다

이벤트라서 치르는 비용도 분명합니다.

- **컴파일러가 지켜주지 않습니다.** 리스너를 실수로 지우면 컴파일 통과, 테스트 통과,
  카운트만 조용히 멈춥니다. 직접 호출이면 원천적으로 불가능한 사고입니다.
- **호출 그래프가 코드에 안 보입니다.** "이 이벤트 누가 듣지"를 알려면 검색을 해야 합니다.

그러니 이건 "이벤트가 더 좋아서"가 아닙니다.

> 알림이 이벤트를 강제하는 상황에서,
> **같은 사실의 파생 반응을 두 경로로 나누지 않는 쪽이 덜 위험하다.**

만약 알림 소비자가 없었다면 — 소비자가 카운터 둘뿐이었다면 — 직접 호출이 맞습니다.
실제로 `ContentReactionDeleted`는 소비자가 카운터 하나뿐이라, 이 이벤트만 놓고 보면 이벤트일 이유가 없습니다.
다른 셋과 짝을 이루기 때문에 같은 형식을 유지하는 것이고, 그건 일관성이라는 별개의 근거입니다.

## 한 줄 요약

| 쓰임 | 애노테이션 |
| --- | --- |
| 원본 쓰기의 일부 (불변식과 롤백을 공유) | `@EventListener` |
| 커밋된 사실의 부수효과 (실패해도 본 요청은 성공) | `@TransactionalEventListener(AFTER_COMMIT)` |

`BEFORE_COMMIT`은 그 사이 어디에도 해당하지 않습니다.
"트랜잭션 안이면서 반드시 커밋 직전이어야 한다"는 요구가 실제로 있을 때만 꺼내는 도구입니다.

## 남은 생각

사실 AI가 코드를 대신 써주는 요새, 코드 레벨에서의 이런 트레이드오프가 크게 문제가 되는 걸까 싶긴 합니다.

`@EventListener`든 `BEFORE_COMMIT`이든 직접 호출이든, **셋 다 컴파일되고 셋 다 테스트를 통과합니다.**
물어보면 어느 쪽이든 그럴듯한 근거까지 붙여서 답해 줍니다.
그럼 이 글처럼 근거를 끝까지 파고드는 일에 얼마나 값이 남을까요.

지금의 잠정적인 답은 이렇습니다.
이 글에서 실제로 결정한 건 애노테이션이 아니었습니다.
**"카운트는 원본 쓰기의 일부인가, 커밋된 사실의 부수효과인가"** 라는 판단이었고,
애노테이션은 그 판단을 코드로 옮긴 결과일 뿐입니다.
앞의 판단은 도메인을 알아야 내릴 수 있고, 코드에는 흔적으로만 남습니다.

그리고 그 판단이 틀렸을 때의 고장은 조용합니다.
예외도 안 나고 로그도 안 남고, 카운트만 조금씩 어긋납니다.
컴파일러도 테스트도 리뷰도 잡아주지 않으니,
결국 누군가는 "이건 왜 이렇게 되어 있지"를 끝까지 따라가야 합니다.

그게 계속 사람 몫으로 남을지는 잘 모르겠습니다.
다만 지금은, 코드를 누가 썼든 **그 코드가 무엇을 보장하기로 한 것인지는 알고 있어야 한다**고 생각합니다.
답이라기보다는, 아직 고민입니다.
