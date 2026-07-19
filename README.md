# pi-quota-footer

Codex, Claude, GLM, Kimi, and Qwen (Alibaba) usage quotas inline in Pi's footer.

## Install

```sh
pi install git:github.com/m7l5/pi-quota-footer
```

The extension uses Pi or provider CLI credentials and never renders tokens. It shows available quota windows, reset countdowns, stale data, and warning thresholds. GLM displays only its 5-hour and weekly model quotas. Qwen shows the Alibaba Cloud Model Studio (Bailian) Token Plan 5-hour and weekly windows; it reads the console session that `bl auth login --console` stores in `~/.bailian/config.json` (the gateway region/site can be overridden with `PI_BAILIAN_CONSOLE_REGION` / `PI_BAILIAN_CONSOLE_SITE`).

## Commands

```text
/quota          Refresh and show details
/quota-footer   Toggle the custom footer
```

MIT
