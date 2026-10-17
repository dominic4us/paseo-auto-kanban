# paseo-auto-kanban (한국어 요약)

**Paseo 에이전트가 스스로 갱신하는 업무 보드입니다.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/lead-dark.gif">
  <img src="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/lead.gif" width="802" alt="총괄(lead) 에이전트 카드에 금색 왕관이 붙고, 총괄이 하위 에이전트 둘에게 일을 나누면 하위마다 총괄 이름이 달린 카드가 생깁니다. 총괄 카드는 하위 카드 수와 실행 중인 수를 세고, 하위 하나가 끝나면 그 카드가 Review로 옮겨 갑니다.">
</picture>

<sub>총괄 에이전트가 하위 에이전트에게 일을 나눠 주는 모습 — 실제 에이전트와 예시 프로젝트로 Paseo에서 녹화했습니다(화면은 영어). <a href="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/lead-dark-still.png">정지 이미지</a></sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/hero-dark.gif">
  <img src="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/hero.gif" width="802" alt="Paseo에서 에이전트를 시작하면 To Do에 카드가 저절로 생기고, 에이전트가 일하는 동안 In progress로 옮겨 가고, 권한을 요청하면 사람을 부르고, 에이전트가 멈추면 Review에서 기다립니다.">
</picture>

<sub>실제 에이전트와 예시 프로젝트로 Paseo에서 녹화했습니다(화면은 영어). <a href="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/hero-dark-still.png">정지 이미지</a></sub>

```sh
paseo plugin install npm:paseo-auto-kanban
```

Paseo 0.9.0 이상이 필요하고, 설치한 뒤 **설정 → Plugins → Enable plugins**를 켭니다. 자세한 순서는 아래 [설치](#설치)에 있습니다.

자세한 내용은 [영어 README](README.md)와 [docs/reference.md](docs/reference.md)를 보세요. 이 문서는 짧은 요약입니다.

Paseo에서 에이전트를 만들면 그 워크스페이스 보드에 카드가 생깁니다. 에이전트가 일하는 동안 카드가 움직이고,
권한을 요청하면 "응답 필요"로 표시되고, 멈추면 검토 칸에서 기다립니다. 에이전트가 멈춘 것과 일이 끝난 것은
다르기 때문에, 완료는 사람이 정합니다. 총괄(오케스트레이터) 에이전트는 `kanban` 명령으로 카드를 만들고 담당
에이전트를 연결할 수 있습니다. 보드는 Paseo 서버 기기의 로컬 파일에 저장됩니다. 플러그인 스스로는 사용 기록을
수집하지 않고 외부 서비스에 접속하지 않습니다. 다만 Paseo가 원래 하는 방식대로, 연결한 Paseo 앱(휴대폰 등)에는 보드가
표시되고, 카드를 에이전트에게 보내기로 확인하면 그 내용이 에이전트(그리고 그 에이전트의 모델 제공사)에게 전달됩니다.

## 왜 쓰나

여러 프로젝트에서 에이전트를 여럿 돌리면 늘 같은 질문이 남습니다. 각자 무엇을 하는지, 누가 나를 기다리는지,
무엇이 정말 끝났는지. Paseo는 채팅을 보여 주고, 이 플러그인은 일을 보여 줍니다. 모든 프로젝트를 한 화면에서 보고,
사람이 손대야 하는 것만 "확인 필요"로 셉니다.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/overview-dark.gif">
  <img src="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/overview.gif" width="800" alt="보드 하나에 여러 프로젝트와 일하는 에이전트가 보이고, 응답을 기다리는 에이전트의 카드를 강조한 뒤, 같은 보드를 휴대폰 화면으로 보여 줍니다.">
</picture>

<sub>예시 데이터. <a href="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/overview-poster.png">움직임 없이 보기</a></sub>

에이전트가 멈췄어도 시험이나 빌드가 아직 돌고 있을 수 있습니다. 그 카드에 진행 표시를 켜면
(`kanban card busy 카드 "Testing"`) 테두리가 점선이 되고, 2시간이 지나면 주황으로 바뀌어 사람을 부릅니다.
카드 상세에서 표시를 보고 끌 수 있습니다.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/busy-dark.gif">
  <img src="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/busy.gif" width="800" alt="검토 칸의 카드에 진행 표시를 켜면 테두리가 점선이 되고, 2시간이 지나면 주황으로 바뀌며 보드의 &quot;Needs attention&quot; 수가 올라갑니다.">
</picture>

<sub>예시 데이터. <a href="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/busy-poster.png">움직임 없이 보기</a></sub>

## 설치

먼저 Paseo 서버(데몬)가 도는 기기의 터미널에서 버전을 확인합니다.

```sh
paseo --version
node -v
```

npm으로 설치하려면 Paseo **0.9.0 이상**이 필요합니다(0.8.x는 폴더나 Git에서만 설치). 선택 사항인 `kanban` 명령은
Node.js **22 이상**이 필요합니다.

1. 같은 터미널에서, Paseo 서버와 같은 사용자 계정으로:

   ```sh
   paseo plugin install npm:paseo-auto-kanban
   ```

   또는 Git에서 릴리스 태그로:

   ```sh
   paseo plugin install https://github.com/panto-dominic/paseo-auto-kanban --ref v0.2.3
   ```

   어느 쪽이든 같은 플러그인입니다. npm 패키지는 0.2.1부터 올라가며, Paseo는 패키지 스크립트를 실행하지 않고 설치합니다.
   npm으로 설치하려면 Paseo 서버 기기에 `npm`이 있어야 합니다. 설치 전에 신뢰 경고가 한 줄 나옵니다.

2. Paseo **설정 → Plugins**에서 **Enable plugins**를 켭니다. 모든 플러그인에 걸리는 스위치라서, 플러그인을 처음 쓰면
   꺼져 있을 수 있고, 꺼져 있으면 설치한 플러그인도 `disabled`로 남습니다(`paseo plugin enable <id>`는 플러그인 하나만
   켜고 이 스위치는 켜지 않습니다).
3. 실행 상태 확인:

   ```sh
   paseo plugin ls
   ```

   `paseo-auto-kanban`이 `running`이면 됩니다. `disabled`면 2번 스위치(또는 플러그인 자체 켬 상태)가 꺼져 있는 것이고,
   불러오기 오류도 같은 목록에 나옵니다.

그러면 Paseo 사이드바에 **Kanban** 항목이 생깁니다. 처음에는 보드가 없어 비어 있습니다(넓은 화면은
"No boards registered yet"). **Paseo 워크스페이스에서 새 채팅을 시작하면** 그 워크스페이스의 보드가 생기고 채팅 카드가
올라옵니다(`kanban init`으로 직접 만들 수도 있습니다). 플러그인을 설치하기 전부터 열려 있던 채팅은 보드를 채우지 않습니다.

**업데이트**: 플러그인과 `kanban` 명령은 따로 설치되므로 둘 다 올립니다.

```sh
paseo plugin update paseo-auto-kanban
npm install -g --prefix ~/.local paseo-auto-kanban@latest
```

둘째 줄은 `kanban` 명령을 그 방법으로 설치한 경우에만 필요합니다. 새 판이 없으면 첫 줄이 `up to date`라고 알려 줍니다.
특정 판으로: npm 설치는 `--version <버전>`, Git 설치는 `--ref <태그>`. 이미 설치된 ID에 `install`을 다시 하면 거부됩니다.
선언한 Paseo 범위는 `>=0.8.0 <1.0.0`입니다(실제로 확인한 조합은 영어 README의 호환 표).

## `kanban` 명령(선택)

```sh
npm install -g --prefix ~/.local paseo-auto-kanban
kanban --version
```

`--prefix ~/.local`은 홈 폴더에 설치해서 `sudo`가 필요 없습니다. 그냥 `npm install -g paseo-auto-kanban`은 npm 전역 폴더가
root 소유(`/usr`·`/usr/local`, apt·NodeSource로 Node.js를 설치했을 때 기본)이면 `EACCES: permission denied`로 실패합니다.
`npm config get prefix`가 이미 홈 아래(nvm 등)를 가리키면 그냥 명령도 됩니다. 명령은 `~/.local/bin`에 생기며, Ubuntu는
이 폴더가 있으면 로그인할 때 `PATH`에 넣습니다. 설치 직후 `kanban`을 못 찾으면 새 터미널을 열거나 `hash -r`을 실행하세요.
`kanban`과 `paseo-kanban` 두 이름이 같은 명령으로 설치됩니다.

이 플러그인의 옛 판이 `~/.local/bin`에 `kanban` 링크를 남겼다면(`ls -l ~/.local/bin/kanban`이 `paseo-kanban` 폴더를
가리킴) 먼저 지우세요. 지우지 않으면 설치가 `EEXIST: file already exists`로 멈춥니다. 다른 도구의 `kanban`이면 지우지
말고 `paseo-kanban` 이름을 쓰세요.

```sh
rm -f ~/.local/bin/kanban
```

소스에서 빌드하는 방법과 명령 설명은 영어 README의 Command line 절에 있습니다.

## 옛 ID `paseo-kanban`에서 옮기기

0.2.0부터 플러그인 ID가 `paseo-auto-kanban`으로 바뀌어 Paseo는 새 플러그인으로 봅니다. 보드 데이터는 ID와 무관해 그대로
남습니다. 위 [설치](#설치)처럼 버전을 확인한 뒤, Paseo 서버와 같은 사용자로:

```sh
cp -a ~/paseo-kanban-data ~/paseo-kanban-data.backup
paseo plugin remove paseo-kanban
paseo plugin ls
paseo plugin install npm:paseo-auto-kanban
paseo plugin ls
```

- `remove`는 지운 항목을 `disabled` 표시로 한 번 보여 줍니다. 이어서 `paseo plugin ls`를 하면 `paseo-kanban` 줄이 없습니다.
  **Enable plugins** 스위치는 켜진 채로 남습니다.
- `install` 뒤 `paseo plugin ls`에 `paseo-auto-kanban` `running`이 보이고, 칸반 화면에 기존 보드·카드가 그대로 있습니다.
  새 채팅을 하나 시작하면 전처럼 카드가 생깁니다.
- 옛 플러그인을 **먼저 제거**하고, 둘을 함께 켜 두지 마세요. 같은 데이터 폴더에서 둘 다 에이전트 이벤트에 반응해 카드가
  제대로 옮겨지지 않습니다. 시험에서는 한쪽이 다른 쪽의 이동을 사람이 옮긴 것으로 보고 그 카드의 자동 이동을 멈춰,
  에이전트가 끝났는데도 카드가 In progress에 남았습니다.

옛 `kanban` 명령을 `~/.local/bin` 링크로 쓰셨다면 옛 플러그인을 지울 때 그 링크가 끊깁니다. npm 패키지로 바꿉니다.

```sh
rm -f ~/.local/bin/kanban
npm install -g --prefix ~/.local paseo-auto-kanban
kanban --version
```

`rm -f` 줄을 빼면 설치가 `EEXIST: file already exists`로 멈춥니다. 이제 `kanban` 명령은 플러그인과 함께 올라가지 않으니
위 업데이트 두 줄로 따로 올리세요. 이전 판에서 한국어로 보던 화면(`config.json`에 `"locale": "ko"`이거나 locale 줄이 없음)은
한국어 그대로입니다.

## 자동으로 일어나는 일과 끄는 법

설정은 칸반 화면 오른쪽 위 톱니 버튼 → **칸반 설정**에 있습니다.

| 무엇 | 기본 | 끄는 법 |
|---|---|---|
| 에이전트 자동 카드(최상위 에이전트마다 카드, 진행에 따라 이동) | 켬 | 설정 → 자동화 → 에이전트 자동 카드, 또는 워크스페이스별 |
| 보드 자동 생성(보드 없는 워크스페이스에서 새 채팅이 시작될 때, 데이터 폴더 안에만) | 켬 | 위와 같은 스위치 |
| 워크스페이스 폴더의 `PROCESS.md`(`kanban init`이나 빈 레인의 **+**로 만든 보드만) | 켬 | `~/paseo-kanban-data/config.json`에 `"exportEnabled": false` |
| 완료 카드 자동 보관(삭제 아님, 되돌리기 가능) | 7일 | 설정 → 자동화 → 완료 카드 자동 보관 → 끄기 |
| 자동 새로고침(화면이 보이는 동안 4초마다 읽기만) | 켬 | 설정 → 자동화 → 자동 새로고침 |

초안 카드를 에이전트에게 보내는 일은 확인 창에서 **보내기**를 눌렀을 때만 일어납니다.

## 데이터와 제거

- 데이터 폴더: `~/paseo-kanban-data`(옛 이름을 그대로 써서 기존 보드가 이어집니다).
- 새로 설치하면 화면이 영어로 시작합니다. 한국어로 쓰려면 `config.json`에 `"locale": "ko"`를 넣으세요.
  이전 버전에서 쓰던 설정은 한국어가 유지됩니다.
- 첫 단계는 곳에 따라 이름이 다릅니다. 저장된 이름이 *Waiting*이라 `kanban ls`에 `todo (Waiting)`으로 나오고, 영어 화면에는
  *To Do*로 보입니다. 둘째 단계는 휴대폰 탭까지 어디서나 *In progress*(한국어 화면은 *진행*)입니다.
- 제거: `paseo plugin remove paseo-auto-kanban`. 지운 항목이 `disabled` 표시로 한 번 나오고, 그 뒤 `paseo plugin ls`에는
  보이지 않습니다. 데이터 폴더와 워크스페이스의 `PROCESS.md`는 남으니 필요 없으면 직접 지우세요. `kanban` 명령은
  `--prefix ~/.local`로 설치했다면 `npm rm -g --prefix ~/.local paseo-auto-kanban`, 그냥 `npm install -g`였다면
  `npm rm -g paseo-auto-kanban`으로 지웁니다.

라이선스: [Apache-2.0](LICENSE)
