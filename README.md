# 자율성과지표 성과관리 — Netlify 배포판

계명문화대학교 혁신지원사업단의 2차년도 자율성과지표 대시보드입니다. **접속 코드·수정 핀 없이** 주소를 아는 사람은 누구나 조회하고 실적을 입력할 수 있습니다. 데이터는 Netlify Blobs에 저장되어 모든 접속자에게 공유됩니다.

## 구성

```
public/                 화면(HTML·CSS·JS)
netlify/functions/api.mjs   데이터 API (/api/*) — Netlify Blobs 저장
data/seed.json          첫 실행 시 들어갈 초기 데이터
netlify.toml            Netlify 설정
package.json            의존성(@netlify/blobs)
```

## 배포 방법 (GitHub → Netlify)

1. **GitHub 저장소 만들기**
   - github.com에서 New repository를 만듭니다. 기관 데이터이므로 **Private**을 권장합니다.
   - 이 폴더의 파일을 모두 올립니다. `node_modules`, `.netlify` 폴더는 올리지 않습니다(`.gitignore`에 포함).
   - 명령줄을 쓴다면:
     ```
     git init
     git add .
     git commit -m "자율성과지표 성과관리 초기 배포"
     git branch -M main
     git remote add origin https://github.com/<계정>/<저장소>.git
     git push -u origin main
     ```
2. **Netlify에 연결하기**
   - app.netlify.com → **Add new project → Import an existing project → GitHub**에서 저장소를 선택합니다.
   - 빌드 설정은 `netlify.toml`이 자동으로 채웁니다. Build command는 비워 두고, Publish directory는 `public`입니다.
   - **Deploy**를 누르면 1~2분 뒤 `https://<사이트이름>.netlify.app` 주소가 생깁니다.
3. **확인**
   - 주소로 접속해 대시보드가 보이는지, 실적 입력 화면에서 값을 저장하고 새로고침해도 남는지 확인합니다.
   - 이후 GitHub에 변경을 올리면 Netlify가 자동으로 다시 배포합니다. 저장된 실적 데이터는 재배포해도 유지됩니다.

## AI 요약보고서 (선택)

Netlify → Site configuration → **Environment variables**에 다음을 추가하고 재배포하면 Claude가 요약 문장을 작성합니다. 없으면 규칙 기반 자동 요약이 나옵니다.

| 이름 | 값 |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com에서 발급한 키 |
| `ANTHROPIC_MODEL` | (선택) 기본 `claude-sonnet-5-5` |

같은 데이터·같은 날짜의 결과는 저장해 두고 재사용하므로 호출이 반복되지 않습니다.

## 데이터 관리

- **백업:** 실적 입력 화면의 **백업 내려받기**(또는 `/api/export`)로 데이터와 변경 이력을 JSON으로 받습니다. 하루 한 번, 그날 첫 변경 직전 상태가 Blobs의 `backup/날짜` 키로 자동 보관됩니다.
- **변경 이력:** 모든 저장은 입력자 이름·시각·접속 IP와 함께 기록됩니다(최근 2,000건).
- **초기화:** Netlify → Blobs → `kpi` 저장소에서 `data`, `history` 항목을 삭제하면 다음 접속 때 `seed.json`으로 다시 시작합니다.
- **지표·목표 변경:** 첫 배포 전이면 `data/seed.json`을 고칩니다. 이미 운영 중이면 Blobs의 `data`를 수정하거나 초기화가 필요합니다.

## 로컬에서 실행해 보기 (선택)

```
npm install
npx netlify-cli dev
```

`http://localhost:8888`에서 열립니다. 로컬 데이터는 실제 배포 데이터와 분리된 임시 저장소를 씁니다.

## 주의

- 로그인이 없으므로 **주소를 아는 누구나 데이터를 보고 수정할 수 있습니다.** 주소는 내부에만 공유하고, 잘못된 수정은 변경 이력과 백업으로 되돌리세요.
- 접근을 제한해야 할 때는 Netlify의 Password Protection(유료 요금제) 기능을 켜는 방법이 있습니다.
- AI 키를 등록하면 누구나 AI 요약을 실행할 수 있어 호출 비용이 생길 수 있습니다(같은 날 같은 데이터는 재사용).
