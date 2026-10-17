# paseo-auto-kanban (日本語の概要)

[English](README.md) · [한국어](README.ko.md) · **日本語** · [简体中文](README.zh-CN.md) · [Español](README.es.md)

**Paseo のエージェントが自分で更新するタスクボード（Board）です。**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/lead-dark.gif">
  <img src="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/lead.gif" width="802" alt="デモ動画：金色の王冠が付いたリードエージェント（Lead）のカード（Card）が、2 つのサブエージェントに作業を割り振ります。各サブエージェントにはリードエージェント名のタグが付いたカードが作られ、リードエージェントのカードにはサブカード数と実行中の数が表示されます。1 つが終了すると、そのカードがレビュー（Review）に移動します。">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/hero-dark.gif">
  <img src="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/hero.gif" width="802" alt="Paseo でエージェントを開始すると、未着手（To Do）にカードが自動で現れ、作業中は進行中（In progress）に移動します。権限を求めると対応を促し、停止するとレビュー（Review）で待機します。">
</picture>

```sh
paseo plugin install npm:paseo-auto-kanban
```

Paseo 0.9.0 以降が必要です。インストール後に **設定（Settings）→ Plugins → Enable plugins** をオンにします。詳しい手順は下の[インストール](#インストール)をご覧ください。

詳細は[英語の README](README.md) と [docs/reference.md](docs/reference.md) をご覧ください。この文書は短い概要です。

Paseo でエージェントを作ると、そのワークスペースのボードにカード（Card）が現れます。エージェントの作業中はカードが移動し、
権限を求めると応答待ち（Needs you）になり、停止するとレビュー（Review）で待機します。エージェントが停止したことと作業の完了は
同じではないため、完了を決めるのは人です。リードエージェントは `kanban` コマンドでカードを作成し、担当
エージェントを紐付けられます。ボードは Paseo サーバーが動くマシンのローカルファイルに保存されます。プラグイン自体は利用状況を
収集せず、外部サービスにも接続しません。ただし、Paseo の通常の仕組みに従って、接続した Paseo アプリには
ボードが表示されます。また、カードをエージェントに送ることを確認すると、その内容がエージェント（およびそのモデル提供元）に送られます。

## なぜ使うのか

複数のプロジェクトで複数のエージェントを動かすと、いつも同じ疑問が残ります。それぞれ何をしているのか、誰が自分の応答を待っているのか、
何が本当に終わったのか。Paseo はチャットを表示し、このプラグインは作業を表示します。すべてのプロジェクトを一画面で見渡せて、
人が対応する必要のあるものだけを「要確認（Needs attention）」として数えます。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/overview-dark.gif">
  <img src="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/overview.gif" width="800" alt="1 つの画面に複数のプロジェクトと作業中のエージェントが表示され、応答待ちのエージェントのカードが強調されます。続いて同じボードがスマートフォンに表示されます。">
</picture>

エージェントが停止しても、テストやビルドがまだ実行中の場合があります。カードに作業中の印を付けると
（`kanban card busy CARD "Testing"`）枠線が破線になり、2 時間後にはオレンジ色になって対応を促します。
カードの詳細でこの印を確認し、解除できます。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/busy-dark.gif">
  <img src="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/main/docs/images/busy.gif" width="800" alt="レビュー（Review）のカードに作業中の印を付けると枠線が破線になり、2 時間後にオレンジ色に変わって、ボードの「要確認（Needs attention）」の数が増えます。">
</picture>

## インストール

まず、Paseo サーバー（デーモン）が動いているマシンのターミナルでバージョンを確認します。

```sh
paseo --version
node -v
```

npm からのインストールには Paseo **0.9.0 以降**が必要です（0.8.x はフォルダーまたは Git からのみインストール可能）。任意の `kanban` コマンドには
Node.js **22 以降**が必要です。

1. 同じターミナルで、Paseo サーバーと同じユーザーとして実行します。

   ```sh
   paseo plugin install npm:paseo-auto-kanban
   ```

   または、Git からリリースタグを指定してインストールします。

   ```sh
   paseo plugin install https://github.com/panto-dominic/paseo-auto-kanban --ref v0.2.3
   ```

   どちらも同じプラグインです。npm パッケージは 0.2.1 から公開されており、Paseo はパッケージのスクリプトを実行せずにインストールします。
   npm からインストールするには Paseo サーバーのマシンに `npm` が必要です。インストール前に信頼に関する警告が 1 行表示されます。

2. Paseo の **設定 → Plugins** で **Enable plugins** をオンにします。これはすべてのプラグインに適用されるスイッチです。初めて使う場合は
   オフのことがあり、オフのままだとインストール済みのプラグインも `disabled` のままです（`paseo plugin enable <id>` は個別のプラグインだけを
   有効にし、このスイッチはオンにしません）。
3. 実行状態を確認します。

   ```sh
   paseo plugin ls
   ```

   `paseo-auto-kanban` が `running` なら正常です。`disabled` は手順 2 のスイッチ（またはプラグイン自体の有効化設定）がオフであることを示します。
   読み込みエラーも同じ一覧に表示されます。

Paseo のサイドバーに **Kanban** が表示されます。最初はボードがないため空です（広い画面では
「No boards registered yet」と表示されます）。**Paseo のワークスペースで新しいチャットを開始すると**、そのワークスペースのボードとチャットのカードが
作られます（`kanban init` で手動作成も可能です）。プラグインをインストールする前から開いていたチャットはボードに追加されません。

> **プラグインはサンドボックスで隔離されていません。** このプラグインは Paseo サーバーのファイルアクセス権限で動作し、Paseo のエージェント API を使用できます。
> インストール前に[自動で行われることと無効にする方法](#自動で行われることと無効にする方法)をご覧ください。

**更新**：プラグインと `kanban` コマンドは別々にインストールされるため、両方を更新します。

```sh
paseo plugin update paseo-auto-kanban
npm install -g --prefix ~/.local paseo-auto-kanban@latest
```

2 行目は、その方法で `kanban` コマンドをインストールした場合にだけ必要です。新しいバージョンがなければ 1 行目は `up to date` と表示します。
特定のバージョンを指定する場合、npm からのインストールは `--version <version>`、Git からは `--ref <tag>` を使います。インストール済みの ID に再度 `install` を実行すると拒否されます。
宣言されている Paseo の範囲は `>=0.8.0 <1.0.0` です（実際に確認済みの組み合わせは英語 README の互換性表をご覧ください）。

## `kanban` コマンド（任意）

```sh
npm install -g --prefix ~/.local paseo-auto-kanban
kanban --version
```

`--prefix ~/.local` はホームフォルダーにインストールするため、`sudo` が不要です。単に `npm install -g paseo-auto-kanban` とすると、npm のグローバルフォルダーが
root 所有（apt や NodeSource から Node.js を入れた場合の既定値である `/usr` または `/usr/local`）なら `EACCES: permission denied` で失敗します。
`npm config get prefix` がすでにホーム内（nvm など）を指していれば、単純なコマンドでも動作します。コマンドは `~/.local/bin` に入り、Ubuntu は
このフォルダーが存在するとログイン時に `PATH` に追加します。インストール直後に `kanban` が見つからなければ、新しいターミナルを開くか `hash -r` を実行してください。
`kanban` と `paseo-kanban` の 2 つの名前で同じコマンドがインストールされます。

このプラグインの旧版が `~/.local/bin` に `kanban` リンクを残している場合（`ls -l ~/.local/bin/kanban` が `paseo-kanban` フォルダーを
指す場合）は、先にそのリンクを削除してください。残っているとインストールが `EEXIST: file already exists` で停止します。別のツールの `kanban` は削除せず、
`paseo-kanban` という名前を使ってください。

```sh
rm -f ~/.local/bin/kanban
```

ソースからのビルド方法とコマンドの説明は、英語 README の Command line 節にあります。

## 旧 ID `paseo-kanban` からの移行

0.2.0 からプラグイン ID が `paseo-auto-kanban` に変わり、Paseo では新しいプラグインとして扱われます。ボードのデータは ID に依存しないため、そのまま
残ります。上の[インストール](#インストール)で説明したようにバージョンを確認し、Paseo サーバーと同じユーザーで実行してください。

```sh
cp -a ~/paseo-kanban-data ~/paseo-kanban-data.backup
paseo plugin remove paseo-kanban
paseo plugin ls
paseo plugin install npm:paseo-auto-kanban
paseo plugin ls
```

- `remove` は削除した項目を `disabled` として一度だけ表示します。その後の `paseo plugin ls` には `paseo-kanban` の行はありません。
  **Enable plugins** スイッチはオンのままです。
- `install` 後の `paseo plugin ls` に `paseo-auto-kanban` が `running` と表示され、Kanban 画面には以前のボードとカードが残ります。
  新しいチャットを開始すれば、以前と同じようにカードが現れます。
- 旧プラグインを**先に削除**し、両方を同時に有効にしないでください。同じデータフォルダーを使い、両方がエージェントのイベントに反応するため、カードが
  正しく移動しなくなります。テストでは、一方がもう一方の移動を人の操作とみなしてカードの自動移動を止め、
  エージェントの終了後もカードが進行中（In progress）に残りました。

以前の `kanban` コマンドを `~/.local/bin` のリンクで使っていた場合、旧プラグインを削除するとリンクが切れます。npm パッケージに切り替えてください。

```sh
rm -f ~/.local/bin/kanban
npm install -g --prefix ~/.local paseo-auto-kanban
kanban --version
```

`rm -f` の行を省くと、インストールは `EEXIST: file already exists` で停止します。今後は `kanban` コマンドがプラグインと一緒には更新されないため、
上の更新用の 2 行で別々に更新してください。以前の版で韓国語表示だった画面（`config.json` に `"locale": "ko"` があるか、locale 行がない場合）は
韓国語のままです。

## 自動で行われることと無効にする方法

設定は Kanban 画面の右上の歯車ボタン → **Kanban 設定（Kanban settings）** にあります。

| 項目 | 既定値 | 無効にする方法 |
|---|---|---|
| エージェントの自動カード（Agent auto cards：最上位エージェントごとにカードを作り、進行に合わせて移動） | オン | 設定 → Automation → Agent auto cards、またはワークスペースごと |
| ボードの自動作成（ボードのないワークスペースで新しいチャットが始まったとき、データフォルダー内だけに作成） | オン | 自動カードと同じスイッチ |
| ワークスペースフォルダーの `PROCESS.md`（`kanban init` または空のレーンの **+** で作ったボードのみ） | オン | `~/paseo-kanban-data/config.json` に `"exportEnabled": false` を設定 |
| 完了カードの自動アーカイブ（Archive finished cards：削除ではなく、復元可能） | 7 日 | 設定 → Automation → Archive finished cards → Off |
| 自動更新（Auto refresh：画面の表示中、4 秒ごとに読み取りのみ） | オン | 設定 → Automation → Auto refresh |

下書きカードがエージェントに送られるのは、確認画面で**送信（Send）**を押したときだけです。

## データとアンインストール

データフォルダーと `PROCESS.md` は非公開として扱ってください。カードのタイトルやメモが含まれています。

- データフォルダー：`~/paseo-kanban-data`（以前のボードを引き継ぐため、旧名を使い続けます）。
- 新規インストール時の画面は英語です。韓国語にするには `config.json` に `"locale": "ko"` を設定してください。
  以前のバージョンから使っている設定は韓国語を維持します。
- 最初のステージは場所によって名前が違います。保存名は *Waiting* のため、`kanban ls` には `todo (Waiting)` と表示され、英語の画面では
  *To Do* と表示されます。2 番目のステージはスマートフォンのタブも含め、すべて *In progress*（韓国語画面では *진행*）です。
- アンインストール：`paseo plugin remove paseo-auto-kanban`。削除した項目は `disabled` として一度表示され、その後の `paseo plugin ls` には
  表示されません。データフォルダーとワークスペースの `PROCESS.md` は残るため、不要なら手動で削除してください。`kanban` コマンドは
  `--prefix ~/.local` でインストールした場合は `npm rm -g --prefix ~/.local paseo-auto-kanban`、単に `npm install -g` を使った場合は
  `npm rm -g paseo-auto-kanban` で削除します。

ライセンス：[Apache-2.0](LICENSE)

この文書は AI によって翻訳されました。不自然な表現があれば、[Issue](https://github.com/panto-dominic/paseo-auto-kanban/issues) でお知らせください。
