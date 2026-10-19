# paseo-auto-kanban (简体中文概要)

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **简体中文** · [Español](README.es.md)

**由 Paseo 智能体自行更新的任务看板（Board）。**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dominic4us/paseo-auto-kanban/main/docs/images/lead-dark.gif">
  <img src="https://raw.githubusercontent.com/dominic4us/paseo-auto-kanban/main/docs/images/lead.gif" width="802" alt="演示动画：带金色皇冠的主导智能体（Lead）卡片（Card）将工作分配给两个子智能体。每个子智能体都有带主导智能体名称标签的卡片；主导智能体卡片显示子卡片数量和运行中的数量。一个子智能体结束后，其卡片移至待审核（Review）。">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dominic4us/paseo-auto-kanban/main/docs/images/hero-dark.gif">
  <img src="https://raw.githubusercontent.com/dominic4us/paseo-auto-kanban/main/docs/images/hero.gif" width="802" alt="在 Paseo 中启动智能体后，卡片会自动出现在待办（To Do）列；智能体工作时移至进行中（In progress），请求权限时提醒您回应，停止后在待审核（Review）列等待。">
</picture>

```sh
paseo plugin install npm:paseo-auto-kanban
```

需要 Paseo 0.9.0 或更高版本；安装后请打开**设置（Settings）→ Plugins → Enable plugins**。详细步骤见下方的[安装](#安装)。

详细信息请参阅[英文 README](README.md) 和 [docs/reference.md](docs/reference.md)。本文仅为简要介绍。

在 Paseo 中创建智能体后，该工作区的看板上会出现一张卡片（Card）。智能体工作时卡片会移动，
请求权限时会显示为需要您回应（Needs you），停止后则在待审核（Review）列中等待。智能体停止并不意味着工作已经完成，
因此是否完成由您决定。主导智能体也可以通过 `kanban` 命令创建卡片并关联负责的
智能体。看板保存在运行 Paseo 服务器的设备上的本地文件中。插件本身不收集使用数据，
也不连接外部服务。不过，按照 Paseo 原有的工作方式，看板会显示在您连接的 Paseo 应用中；
当您确认将卡片发送给智能体时，卡片内容会传递给该智能体（以及其模型提供商）。

## 为什么需要它

在多个项目中同时运行多个智能体时，总会遇到同样的问题：各自在做什么、谁在等我回应、
哪些工作才算真正完成？Paseo 展示对话，而这个插件展示工作。您可以在一个屏幕中查看所有项目，
“需要关注（Needs attention）”计数只统计需要人工处理的事项。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dominic4us/paseo-auto-kanban/main/docs/images/overview-dark.gif">
  <img src="https://raw.githubusercontent.com/dominic4us/paseo-auto-kanban/main/docs/images/overview.gif" width="800" alt="同一屏幕显示多个项目和正在工作的智能体，突出显示等待回应的智能体卡片，随后在手机上展示同一个看板。">
</picture>

智能体停止后，测试或构建可能仍在运行。给卡片添加忙碌标记
（`kanban card busy CARD "Testing"`）后，边框会变为虚线；两小时后变为橙色，提醒您处理。
您可以在卡片详情中查看并清除该标记。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dominic4us/paseo-auto-kanban/main/docs/images/busy-dark.gif">
  <img src="https://raw.githubusercontent.com/dominic4us/paseo-auto-kanban/main/docs/images/busy.gif" width="800" alt="待审核（Review）卡片被标记为忙碌后，边框变为虚线；两小时后变为橙色，看板的“需要关注（Needs attention）”计数随之增加。">
</picture>

## 安装

首先，在运行 Paseo 服务器（守护进程）的设备上打开终端，检查版本。

```sh
paseo --version
node -v
```

通过 npm 安装需要 Paseo **0.9.0 或更高版本**（0.8.x 只能从文件夹或 Git 安装）。可选的 `kanban` 命令需要
Node.js **22 或更高版本**。

1. 在同一终端中，以运行 Paseo 服务器的同一用户执行：

   ```sh
   paseo plugin install npm:paseo-auto-kanban
   ```

   或者，通过 Git 指定发布标签安装：

   ```sh
   paseo plugin install https://github.com/dominic4us/paseo-auto-kanban --ref v0.2.4
   ```

   两种方式安装的是同一个插件。npm 包从 0.2.1 起发布，Paseo 安装时不会执行包脚本。
   通过 npm 安装需要 Paseo 服务器所在的设备上有 `npm`。安装前会显示一行信任警告。

2. 在 Paseo 的 **设置 → Plugins** 中打开 **Enable plugins**。此开关适用于所有插件；首次使用插件时
   它可能处于关闭状态。未打开时，即使已经安装，插件也会保持 `disabled`（`paseo plugin enable <id>` 仅启用单个插件，
   不会打开此开关）。
3. 检查运行状态：

   ```sh
   paseo plugin ls
   ```

   `paseo-auto-kanban` 显示为 `running` 即可。`disabled` 表示第 2 步的开关（或插件自身的启用状态）处于关闭状态，
   加载错误也会显示在同一列表中。

随后，Paseo 侧栏会出现 **Kanban**。最初没有看板，因此内容为空（宽屏上显示
“No boards registered yet”）。**在 Paseo 工作区中开始新对话后**，就会创建该工作区的看板及对话卡片
（也可以用 `kanban init` 手动创建）。安装插件前已打开的对话不会被添加到看板。

> **插件不在沙盒中运行。** 此插件以 Paseo 服务器的文件访问权限运行，并可使用 Paseo 的智能体 API。
> 安装前请阅读[自动执行的操作及关闭方法](#自动执行的操作及关闭方法)。

**更新**：插件和 `kanban` 命令分别安装，因此需要分别更新。

```sh
paseo plugin update paseo-auto-kanban
npm install -g --prefix ~/.local paseo-auto-kanban@latest
```

只有通过这种方式安装了 `kanban` 命令，才需要执行第二行。如果没有更新版本，第一行会显示 `up to date`。
指定版本时，npm 安装使用 `--version <version>`，Git 安装使用 `--ref <tag>`。对已安装的 ID 再次执行 `install` 会被拒绝。
声明支持的 Paseo 范围为 `>=0.8.0 <1.0.0`（实际验证过的组合见英文 README 的兼容性表）。

## `kanban` 命令（可选）

```sh
npm install -g --prefix ~/.local paseo-auto-kanban
kanban --version
```

`--prefix ~/.local` 会安装到用户主目录，因此不需要 `sudo`。如果直接执行 `npm install -g paseo-auto-kanban`，而 npm 的全局目录
属于 root（通过 apt 或 NodeSource 安装 Node.js 时，默认是 `/usr` 或 `/usr/local`），就会报 `EACCES: permission denied`。
如果 `npm config get prefix` 已指向主目录内的位置（如 nvm），不加前缀的命令也可以使用。命令会安装到 `~/.local/bin`；Ubuntu 会在
该目录存在时于登录时将其加入 `PATH`。如果刚安装完就提示找不到 `kanban`，请打开新终端或运行 `hash -r`。
安装后会有 `kanban` 和 `paseo-kanban` 两个名称，指向同一工具。

如果此插件的旧版本在 `~/.local/bin` 中留下了 `kanban` 链接（`ls -l ~/.local/bin/kanban` 显示它指向 `paseo-kanban` 文件夹），
请先删除该链接，否则安装会因 `EEXIST: file already exists` 而停止。如果 `kanban` 属于其他工具，请不要删除，
改用 `paseo-kanban` 名称。

```sh
rm -f ~/.local/bin/kanban
```

从源码构建的方法和命令说明见英文 README 的 Command line 一节。

## 从旧 ID `paseo-kanban` 迁移

从 0.2.0 起，插件 ID 改为 `paseo-auto-kanban`，Paseo 因此会将它视为新插件。看板数据与 ID 无关，会原样保留。
请按上方[安装](#安装)一节检查版本，然后以运行 Paseo 服务器的同一用户执行：

```sh
cp -a ~/paseo-kanban-data ~/paseo-kanban-data.backup
paseo plugin remove paseo-kanban
paseo plugin ls
paseo plugin install npm:paseo-auto-kanban
paseo plugin ls
```

- `remove` 会将删除的条目以 `disabled` 状态显示一次；随后运行 `paseo plugin ls` 时，将不再出现 `paseo-kanban` 行。
  **Enable plugins** 开关保持开启。
- `install` 后，`paseo plugin ls` 会显示 `paseo-auto-kanban` 为 `running`，Kanban 界面中仍有原来的看板和卡片。
  开始新对话后，卡片会像以前一样出现。
- 请**先移除旧插件**，不要同时启用两者。它们使用同一数据目录，且都会响应智能体事件，导致卡片无法
  正常移动。测试中，其中一个插件将另一个插件的移动当成了人工操作，因而停止自动移动该卡片，
  使卡片在智能体结束后仍停留在进行中（In progress）。

如果您通过 `~/.local/bin` 中的链接使用旧 `kanban` 命令，移除旧插件后该链接会失效。请改用 npm 包。

```sh
rm -f ~/.local/bin/kanban
npm install -g --prefix ~/.local paseo-auto-kanban
kanban --version
```

省略 `rm -f` 这一行会导致安装因 `EEXIST: file already exists` 而停止。此后 `kanban` 命令不会再随插件一起更新，
请用上方更新部分的两行命令分别更新。旧版本中以韩语显示的界面（`config.json` 中有 `"locale": "ko"` 或没有 locale 行）
会继续使用韩语。

## 自动执行的操作及关闭方法

点击 Kanban 界面右上角的齿轮按钮 → **看板设置（Kanban settings）**，即可打开设置。

| 操作 | 默认值 | 关闭方法 |
|---|---|---|
| 智能体自动卡片（Agent auto cards：为每个顶层智能体创建卡片，并随进度移动） | 开启 | 设置 → Automation → Agent auto cards，或按工作区设置 |
| 自动创建看板（在没有看板的工作区开始新对话时，仅在数据目录内创建） | 开启 | 与自动卡片使用同一开关 |
| 工作区文件夹中的 `PROCESS.md`（仅限通过 `kanban init` 或空泳道的 **+** 创建的看板） | 开启 | 在 `~/paseo-kanban-data/config.json` 中设置 `"exportEnabled": false` |
| 自动归档已完成卡片（Archive finished cards：不是删除，可以恢复） | 7 天 | 设置 → Automation → Archive finished cards → Off |
| 自动刷新（Auto refresh：界面可见时每 4 秒只读查询一次） | 开启 | 设置 → Automation → Auto refresh |

只有在确认窗口中点击**发送（Send）**，才会将草稿卡片发送给智能体。

## 数据与卸载

请将数据目录和 `PROCESS.md` 视为私密内容：其中包含卡片标题和备注。

- 数据目录：`~/paseo-kanban-data`（沿用旧名称，以继续使用已有看板）。
- 新安装的界面默认使用英语。若要使用韩语，请在 `config.json` 中设置 `"locale": "ko"`。
  旧版本已有的设置会保留韩语。
- 第一个阶段的名称因位置而异。存储名称为 *Waiting*，因此 `kanban ls` 显示为 `todo (Waiting)`，而英文界面
  显示为 *To Do*。第二个阶段在所有位置（包括手机标签页）均为 *In progress*（韩语界面为 *진행*）。
- 卸载：`paseo plugin remove paseo-auto-kanban`。删除的条目会以 `disabled` 状态显示一次，之后 `paseo plugin ls` 中
  不再显示它。数据目录及工作区中的 `PROCESS.md` 会保留，如不再需要，请自行删除。卸载 `kanban` 命令时，
  若通过 `--prefix ~/.local` 安装，请使用 `npm rm -g --prefix ~/.local paseo-auto-kanban`；若直接使用了 `npm install -g`，
  则使用 `npm rm -g paseo-auto-kanban`。

许可证：[Apache-2.0](LICENSE)

本文由 AI 翻译。如有不自然的表述，请通过 [Issue](https://github.com/dominic4us/paseo-auto-kanban/issues) 告知我们。
