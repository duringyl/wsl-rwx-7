# wsl-rwx-7

> WSL 的 MCP 服务器：**r**ead（读）/ **w**rite（写）/ e**x**ecute（执行）—— `rwx` = 读 + 写 + 执行，`7` = 二进制`111`。

这是一个 [Model Context Protocol](https://modelcontextprotocol.io/)（MCP，模型上下文协议）服务器，让 AI Agent（智能体，如 Claude、Cursor、Trae、Cline 等）能在 Windows 环境下操作 WSL（Windows Subsystem for Linux）的文件系统：**读取文件、写入文件、执行 shell 命令、在 Windows 路径与 Linux（WSL）路径之间相互转换**。

主要解决两个痛点：① 从 Windows 读写 WSL 内的文件不方便；② 通过 PowerShell 执行 WSL（Linux）命令时，引号、`$`、反引号等特殊字符容易产生转义错误。本项目通过 `bash -s` + stdin 管道方式传递命令，彻底绕开 Windows 命令行解析，杜绝转义问题。

本项目 fork 自 [`webconsulting/mcp-server-wsl-filesystem`](https://github.com/webconsulting/mcp-server-wsl-filesystem)，做了大量增强（新增 `exec_command`、`copy_file`、`delete_file`、`convert_path` 等工具），详见[与原项目的差异](#与原项目的差异)。

> **English Note**: `wsl-rwx-7` is a MCP server that lets AI agents (Claude, Cursor, Trae, Cline, etc.) operate on WSL (Windows Subsystem for Linux) filesystems from Windows: read files, write files, run shell commands, and convert between Windows paths and Linux (WSL) paths. It solves two pain points: ① reading/writing WSL files from Windows is inconvenient; ② running WSL commands through PowerShell easily causes escaping errors with quotes, `$`, backticks, etc. This project passes commands via `bash -s` + stdin pipeline, completely bypassing Windows command-line parsing and eliminating escaping issues. &#x20;

> 本项目在开发过程中使用了 AI 编程助手辅助。

---

## 特性

- **读**文件：`read_file`、`read_file_by_parts`、`read_multiple_files`、`directory_tree`、`list_directory`、`get_file_info`、`search_in_files`、`search_files_by_name`
- **写**文件：`write_file`、`edit_file`、`create_directory`、`move_file`、`copy_file`、`delete_file`
- **执行** shell 命令：`exec_command` —— 使用 login shell，能够自动加载用户在`~/.bashrc`、`~/.profile`中定义的环境变量。
- **路径转换**：`convert_path` 在 Windows 风格（`C:\Users\foo`）和 WSL 风格（`/mnt/c/Users/foo`）之间互转
- **安全转义**：命令通过 `bash -s` 从 stdin 传入，**不经 Windows 命令行**，因此 `$`、`` ` ``、`"`、`'`、`\`、空格、非 ASCII 内容都原样保留
- **路径白名单**：文件操作限制在配置的目录内（`exec_command` 不受此限制，见[安全说明](#安全说明)）
- **Agent 友好**：所有工具的描述都包含 `WSL` 关键词，`tool_search` 一次搜索即可发现全部工具

---

## 安装

> **注意**：本 MCP 服务器运行在 **Windows** 端，但它操作的是 WSL 内的文件系统。因此白名单目录参数（如 `/home/youruser/your/project`）必须是 **WSL 内的 Linux 路径**，而非 Windows 路径。运行参数（`--distro`、白名单目录等）在下方 [MCP 客户端配置](#mcp-客户端配置) 中设置。

### 方式一：npx 直接从 GitHub 运行（推荐）

无需克隆或安装，npx 会直接从 GitHub 拉取并运行：

```json
{
  "mcpServers": {
    "wsl-rwx-7": {
      "command": "npx",
      "args": ["-y", "github:duringyl/wsl-rwx-7", "--distro=Ubuntu-24.04", "/home/user/project"],
      "transport": "stdio"
    }
  }
}
```

> 首次运行时 npx 会自动从 GitHub 下载源码并构建，请耐心等待。

### 方式二：克隆源码构建

```bash
git clone https://github.com/duringyl/wsl-rwx-7.git
cd wsl-rwx-7
npm install
npm run build
```

构建产物为 `dist/index.js`，在 mcp.json 中用 `node dist/index.js` 启动（见下方配置示例）。

---

## MCP 客户端配置

在 MCP 客户端配置文件（如 `mcp.json`）中添加：

```json
{
  "mcpServers": {
    "wsl-rwx-7": {
      "command": "npx",
      "args": [
        "-y",
        "github:duringyl/wsl-rwx-7",
        "--distro=Ubuntu-24.04",
        "/home/youruser/your/project"
      ],
      "transport": "stdio"
    }
  }
}
```
或者使用本地构建的 `index.js`（Windows 路径需用双反斜杠转义）：
```json
{
  "mcpServers": {
    "wsl-rwx-7": {
      "command": "C:\\Path\\To\\nodejs\\node.exe",
      "args": [
        "C:\\Path\\To\\wsl-rwx-7\\dist\\index.js",
        "--distro=Ubuntu-24.04",
        "/home/youruser/your/project"
      ],
      "transport": "stdio"
    }
  }
}
```

### 启动参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `<allowed-directory>` | 是 | 一个或多个 WSL 路径，文件操作限制在这些目录内 |
| `--distro=<name>` | 否 | WSL 发行版名称（默认使用系统默认发行版） |
| `--forbidden-commands=a,b,c` | 否 | 额外要在 `exec_command` 中拦截的命令，逗号分隔 |
| `--exec-timeout=<ms>` | 否 | `exec_command` 超时时间，毫秒（默认 30000） |
| `--max-output=<bytes>` | 否 | `exec_command` 最大输出字节数（默认 100000） |

---

## 工具列表

### 读取类

- `read_file` —— 读取文件完整内容
- `read_file_by_parts` —— 分块读取大文件（每块约 95k 字符）
- `read_multiple_files` —— 一次调用读取多个文件
- `list_directory` —— 列出目录内容（类似 ls）
- `directory_tree` —— 递归目录树（JSON 格式）
- `get_file_info` —— 文件元数据（类似 stat）
- `search_in_files` —— 在文件中搜索文本（类似 grep）
- `search_files_by_name` —— 按名称模式查找文件/目录

### 写入类

- `write_file` —— 创建或覆盖文件
- `edit_file` —— 基于行的编辑，返回 diff
- `create_directory` —— 创建目录（mkdir -p）
- `move_file` —— 移动或重命名（mv）
- `copy_file` —— 复制（cp），默认拒绝覆盖已存在文件
- `delete_file` —— 删除文件或目录（rm -rf）

### 执行类

- `exec_command` —— 在 WSL 中执行 shell 命令（login shell，自动加载 `~/.profile`）

### 工具类

- `convert_path` —— Windows 与 WSL 路径风格互转
- `list_wsl_distributions` —— 列出已安装的 WSL 发行版
- `list_allowed_directories` —— 列出配置的白名单目录

---

## 安全说明

- 文件操作（`read_file`、`write_file`、`copy_file` 等）**限制在白名单目录内**。
- `exec_command` **不受白名单限制**——可以在 WSL 的任意位置执行命令。这是有意设计；白名单仅约束 `cwd` 参数。
- `exec_command` 中的危险命令过滤是**尽力而为**，不是安全边界。它会拦截明显的破坏性模式（`rm -rf /`、`sudo`、fork 炸弹等），但可以被绕过。请谨慎使用，请勿依赖它做安全防护。
- 所有命令通过 stdin 传给 bash（`bash -s`），内容中的特殊字符不会被 Windows shell 解释。

---

## 运行要求

- 已启用 WSL2 的 Windows
- 至少安装一个 WSL 发行版
- Node.js >= 18

---

## 开发

```bash
npm install
npm run build            # 编译 TypeScript 到 dist/
npm run watch            # 监听模式
node test/run-tests.mjs  # 运行测试套件
```

---

## 许可证

MIT，详见 [LICENSE](./LICENSE)。

原始代码由 [Web-C](https://github.com/webconsulting)（`mcp-server-wsl-filesystem`）编写，该项目本身基于 Anthropic 的 MCP 服务器模板。Fork 改动由 [duringyl](https://github.com/duringyl) 完成。

---

## 致谢

- [webconsulting/mcp-server-wsl-filesystem](https://github.com/webconsulting/mcp-server-wsl-filesystem) —— 本项目 fork 的原项目
- [Anthropic](https://www.anthropic.com/) —— MCP 协议和服务器 SDK
