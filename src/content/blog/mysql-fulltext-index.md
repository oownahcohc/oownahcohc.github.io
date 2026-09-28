---
title: 'MySQL 인덱스 : Full Text search 인덱스'
description: 'mysql 인덱스 : 전문 검색 인덱스'
pubDate: '2023-12-15'
tags: ['mysql', 'index', 'database', 'real-mysql']
series:
  id: real-mysql
  order: 10
  label: '전문 검색 인덱스'
---

## FULL TEXT SEARCH INDEX

- **문서의 내용 전체를 인덱스화**하기 때문에 일반적으로 인덱싱에 사용하는 `B-Tree` 인덱스를 사용하지 않음
- 키워드로 인덱스를 구축
  - 어근 분석 : 복잡하고 전문적인 알고리즘 이기 때문에 사용하기 쉽지 않음
  - `n-gram` : 단순 키워드 검색을 위한 인덱싱 알고리즘

### 1. n-gram 알고리즘

**공백으로 단어를 분리하고, 단어를 `n` 길이로 잘라서 인덱싱하는 방법**

- `n-gram` 에서 `n`은 인덱싱할 키워드의 최소 글자 수 : 일반적으로 `n=2`임
  - `ngram_token_size` 시스템 변수를 통해 변경 가능
  - 이 값에 따라 검색어 길이 제약이 생기므로 `2` 또는 `3` 이 가장 많이 사용됨
  - `검색어의 길이 >= ngram_token_size`
- 잘려진 토큰들을 full text index 를 이용해 동등 조건으로 검색하므로, 2, 3 보다 큰 검색어도 조회 가능

### 2. 쿼리 모드

1. **자연어 검색(NATURAL LANGUAGE MODE) : default**
   - 검색어를 많이 포함하고 있는 순서대로 정렬해서 결과 반환
   - 문장 검색 시 : 검색어에 사용된 모든 단어가 포함된 레코드 + 일부만 포함하는 결과도 조회
     1. 검색어를 구분자를 통해 단어로 분리
     2. n-gram 파서로 토큰 생성
     3. 토큰에 대해 일치하는 단어 개수 확인
     4. 일치율 확인

2. **불리언 검색(BOOLEAN MODE)**
   - 검색어의 존재 여부에 대한 논리적 연산 가능
   - `+`가 붙은 검색어는 full text index 칼럼에 존재해야함.
   - `-`가 붙은 검색어는 full text index 칼럼에 없어야함.
   - `+`,`-` 가 없다면 `NATURAL LANGUAGE MODE`와 거의 흡사하게 동작.
     - 다만 서로 다른 방식으로 일치율 계산하므로, 완전히 같지는 않음
