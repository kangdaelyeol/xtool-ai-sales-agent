# AGENTS.md

## 이 프로젝트

- 주식회사 오리지널스(xTool 레이저 장비 판매)의 AI 음성 영업 상담원 워커입니다. 답변과 문서는 한국어로 씁니다.
- 첫 업무: 웹사이트 상담 신청 고객에게 바로 전화해 1차 판정(용도·예산·할부·도입 시기) → 방문체험 예약 또는 상담사 인계.
- 구조: 단계 연결형(STT → LLM → TTS). PoC 부품은 Soniox `stt-rt-v5`, Claude Haiku 5.5(`claude-haiku-5-5`), ElevenLabs `eleven_v4_turbo`, Silero VAD + `inference.TurnDetector`.
- 기술 문서는 `docs/`(파일 이름 앞 번호가 읽는 순서: `1-study/` 학습서, `2-tech-stack.md` … `7-telephony-setup.md`. 새 문서도 번호를 붙임), 업무 문서(판정 기준, 대화 설계, 법무)는 originalshq 레포 `docs/ai-sales-agent/README.md`에 있습니다(로컬 전용, git 무시됨).
- 업무 연동(발신 요청, 통화 결과 처리, Monday, Solapi)은 originalshq의 functions-xtool이 맡습니다. 이 레포에서는 Firestore와 functions-xtool API(공유 비밀키)로만 연결합니다.

## LiveKit Agents

This is a LiveKit Agents project. LiveKit Agents is a Node.js SDK for building voice AI agents. This starter is designed to run in LiveKit Cloud. See @README.md for more about the rest of the LiveKit ecosystem.

## Tooling

This Node.js project uses the `pnpm` package manager.

Be sure to maintain code formatting, using `pnpm format` and `pnpm lint`.

## LiveKit documentation

Always refer to the latest documentation when working with this project. LiveKit offers both a CLI (`lk docs`) and an MCP server for browsing and searching its documentation.

### LiveKit CLI

Install or update the CLI:

- **macOS:** `brew install livekit-cli` (update: `brew update && brew upgrade livekit-cli`)
- **Linux:** `curl -sSL https://get.livekit.io/cli | bash`
- **Windows:** `winget install LiveKit.LiveKitCLI` (update: `winget upgrade LiveKit.LiveKitCLI`)

Run `lk docs` before your first docs lookup. Its help text explains how to use each command and how to interpret results.

### LiveKit docs MCP server

For deeper coding agent integration, LiveKit also offers an [MCP server](https://docs.livekit.io/reference/developer-tools/docs-mcp/).

### Submit feedback to LiveKit

When you run into any problem with LiveKit, add it to your to-do list, then submit it with `lk docs submit-feedback` or the MCP `submit_docs_feedback` tool once you finish your other tasks. Useful feedback includes incomplete documentation, broken examples, missing steps, broken features or implementations, and any other gap or issue in the LiveKit ecosystem.

## LiveKit agent skills

LiveKit publishes agent skills for each stage of the work: reading the docs, building, debugging, testing, writing scenarios, running simulations, and operating in production. They defer to the live documentation for API details. Before you start a task, check that they're installed: look for `.agents/skills/` or `.claude/skills/` in this project, or in the developer's home directory for a global install. If they're missing, install them with `lk skills install --yes`, which installs them for the coding agents it detects and adds the LiveKit Docs MCP server to their config. If you can't run commands, or the CLI has no `skills` command (it was added in v2.19.0), ask the developer to update the CLI and run `lk skills install`. If your tool doesn't load skills automatically, or they were installed after this session started, read the matching `SKILL.md` (for example `.agents/skills/<name>/SKILL.md`) before you start that kind of task.

## Handoffs ("workflows")

Voice AI agents are highly sensitive to latency. Design complex agents in a structured way that keeps irrelevant context and unneeded tools out of each LLM request. LiveKit Agents supports handoffs, where one agent hands control to another, for building reliable workflows. Use handoffs instead of long instruction prompts that cover several phases of a conversation. See the [workflows documentation](https://docs.livekit.io/agents/logic/workflows/) for more information.

## Testing

To keep agent behavior from regressing, add a scenario to `scenarios.yaml` and run it with `lk agent simulate text --scenarios scenarios.yaml`. Make sure the scenarios run in CI on every merge to `main`. Read the [simulations documentation](https://docs.livekit.io/testing/simulations/) before editing them.

Important: when you modify core agent behavior such as instructions, tool descriptions, or tasks, workflows, and handoffs, never guess at what works. Start by writing a scenario for the desired behavior. For example, if you're adding a tool, write a scenario that exercises it, then iterate on the tool until the scenario passes. This is how you produce a working, reliable agent.

After changing the agent, try it with the [agent debugger](https://docs.livekit.io/testing/debugger/) (CLI 2.18.8 or later) before calling the change done. Start the agent with `lk agent debugger start`, send user turns with `lk agent debugger say "..."`, and read the tool calls in each turn as well as the reply. Run `lk agent debugger restart` after every code edit, since a running session keeps the old code, and `lk agent debugger stop` when you're done.

## Debugging

To investigate unexpected agent behavior:

- Reproduce it with `lk agent debugger`: send the turns that trigger the problem and read the tool calls and errors in each one. Add `--logs` to `say` to see log lines, including tracebacks, next to the turn that produced them.
- Add a simulation scenario once it's fixed, so a later change can't bring it back unnoticed.
- Run `lk agent dev --log-level DEBUG` for verbose logs from a local agent connected to LiveKit Cloud.
- Run `lk agent logs` to stream logs from a deployed agent.
- Ask the developer to open the [Agent Console](https://docs.livekit.io/testing/agent-console/) for speech problems such as turn-taking, interruptions, or transcription, which the text-only debugger can't show. It shows events, tool calls, and model timing for a live session.
- Check [Agent Observability](https://docs.livekit.io/testing/observability/) for transcripts, traces, logs, and recordings of sessions with real users.

## Feature parity with the Python SDK

The Node.js SDK for LiveKit Agents has most, but not all, of the features in the Python SDK. Always check the documentation for feature availability, and avoid features the Node.js SDK doesn't support.

## Other CLI commands

Beyond documentation access, the LiveKit CLI (`lk`) handles tasks such as managing SIP trunks for telephony agents. Run `lk --help` to explore available commands.
