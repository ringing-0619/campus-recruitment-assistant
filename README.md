# Campus Recruitment Assistant

English | [简体中文](README.zh-CN.md)

A local-first job application tracker that brings application records, 126 Mail notifications, recruitment-site updates, and action items into one dashboard. Manage China's autumn campus recruiting and U.S. job searches in separate workspaces.

**App 3.1.0 · Browser extension 3.6.4 · Node.js 22.13+ (22.x) or 24.x · Full functionality on macOS**

The interface and detailed guides are currently primarily in Chinese. This README explains installation, features, and limitations in English.

## Features

- **Application dashboard:** Track companies, roles, stages, actual application dates, channels, résumé versions, and notes. Search, archive, import, and export records.
- **Automatic email sync:** Connect to 126 Mail over read-only IMAP. Identify application receipts, assessments, written tests, human or AI interviews, offers, and rejections. Apply updates automatically when confidence is high and the application match is unambiguous.
- **Browser sidebar:** Grant access to individual sites in Chrome or Edge, preview and edit extracted job details, and confirm before recording them. Monitor authorized application-status pages after a record has been added.
- **Goals and analytics:** Maintain separate daily and weekly goals for China and the U.S., with trends, conversion funnels, feedback coverage, and time spent at each stage.
- **Actions and calendar:** Manage assessment and interview tasks, reschedule, complete, or cancel them, detect scheduling conflicts, export `.ics` files, and receive macOS notifications.
- **Traceable updates:** Review uncertain matches with explanations. Automatic changes have an audit trail and can be undone; repeated syncs do not create duplicate events.

A fresh installation starts with an empty database. Runtime data stays on your machine; the source does not include personal application records, mailbox settings, or authorization codes.

## Requirements

| Component         | Requirement                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js           | 22.x starting at 22.13.0, or 24.x. The 22.x version specified in `.nvmrc` is recommended.                                                                  |
| npm               | Included with a supported Node.js installation. Use `npm ci` to install from the lockfile.                                                                 |
| Operating system  | macOS provides full functionality. Core web/API functionality on other platforms does not include the macOS Keychain or desktop notification integrations. |
| Browser extension | Chrome or Edge 116 or later.                                                                                                                               |
| Mailbox           | An `@126.com` account with IMAP enabled and a client authorization code.                                                                                   |

The app uses Node.js's built-in SQLite support, so no separate database installation is required. Some Node.js 22 releases display an experimental SQLite warning.

## Quick start

Download or clone the source, then run the following commands from the project root:

```bash
npm ci
npm run build
npm start
```

Open the [local dashboard](http://127.0.0.1:43110). Stopping the process in the terminal stops a manually started server.

On macOS, you can also double-click `启动校招助手.command`. The launcher reuses an existing assistant service. If no service is running, it installs missing dependencies, builds the app, waits for the service to be ready, and opens your browser.

To start automatically when you log in to macOS:

```bash
npm run install:agent
```

Run `npm run uninstall:agent` to remove automatic startup. Your database and Keychain credentials are retained.

### Connect your mailbox

1. Enable IMAP in your 126 Mail settings and generate a client authorization code.
2. Open **Connection Settings (连接设置)** in the assistant, enter your email address and 16-character authorization code, and verify the connection.
3. The first sync reads the most recent 90 days. Subsequent incremental syncs run every 10 minutes; you can also select **Sync Now (立即同步)**.

The authorization code is stored in macOS Keychain. Sync does not mark messages as read, move or delete messages, or send replies. Candidate messages larger than 2 MB are skipped.

### Install the browser extension

1. Open `chrome://extensions` or `edge://extensions` and enable Developer mode.
2. Select **Load unpacked** and choose the project's `extension/` directory.
3. Copy the pairing token from the assistant's **Connection Settings (连接设置)** and paste it into the extension's options.
4. Open the extension sidebar on a recruitment website, choose the appropriate job-search workspace, grant site access, preview the job details, and confirm before recording.

Grant access only to the sites you need. After updating the extension, reload it on the extensions page and refresh the recruitment page. Website monitoring pauses while the browser is closed.

## Email recognition and matching

Emails are processed in four steps: **intent filtering → current stage detection → company and role matching → update**.

- Advertisements, courses, recruiting presentations, job recommendations, and account-verification messages are filtered out.
- Automatic updates require parsing and matching confidence scores of at least 90% and an unambiguous match. Conflicts or insufficient identifying information go to **Pending Review (待确认)**. These are rule-based confidence thresholds, not a measured accuracy claim.
- Matching prioritizes the company, application identifier, previously linked conversation, and full role information, while retaining city, business unit, and role specialization.
- An assessment that does not name a role can be linked to a company's sole active application. Multiple applications at the same company require reliable distinguishing evidence.
- Assessment, written-test, and interview notices update existing applications. Only an unambiguous application receipt with a complete company and role can automatically create a new application.
- Recognition handles résumé-database acknowledgments, reminder labels, roles in parentheses, and explicit validity periods in hours or days. Recommendation sections, test durations, and signature dates are not treated as job details or scheduled events.
- Older notices do not move a newer application stage backward or reopen completed tasks. Ignored or undone emails are not automatically applied again.
- After a rules upgrade, the most recent 90 days are rechecked. Historical emails retain their assigned workspace.

See [Email Recognition and Matching](docs/email-recognition.md) for examples in Chinese.

## Development and validation

```bash
npm ci
npm run dev          # Separate development database; web UI at http://127.0.0.1:5173
npm run format       # Format the repository
npm run validate     # Formatting, types, tests, repository checks, build, and empty-database smoke test
npm audit            # Dependency audit; requires internet access
npm run package:source
```

The development server defaults to port `43111` and `data/runtime/development.sqlite`. The production server defaults to port `43110` and `data/runtime/campus-assistant.sqlite`. See `.env.development.example` for development settings and `.env.example` for production settings.

GitHub Actions is configured to run full validation on Ubuntu and macOS with Node.js 22 and 24. CI does not connect to a real mailbox or read the developer's Keychain.

## Project structure

```text
.github/             CI, dependency updates, and issue/PR templates
src/server/          Local API, SQLite, email sync, recognition, matching, and auditing
src/shared/          Types, time handling, and analytics rules
src/web/             Web interface and styles
extension/           Manifest V3 browser extension
tests/               Automated tests and sanitized fixtures
scripts/             Startup, validation, smoke testing, packaging, and login-agent scripts
docs/                User, architecture, configuration, development, and GitHub guides
public/              Distributable static assets
data/                Local runtime data; actual contents are ignored by Git
```

## Additional documentation

The following guides are currently in Chinese:

- [User Guide](docs/user-guide.md): Dashboard, goals, calendar, reminders, and data recovery.
- [Configuration](docs/configuration.md): Ports, databases, optional migrations, and platform support.
- [Architecture](docs/architecture.md): Module boundaries, synchronization, and data flow.
- [API Overview](docs/api.md): Main endpoints, workspace parameters, and extension authentication.
- [Development and Validation](docs/development.md): Test coverage, CI, and dependency maintenance.
- [GitHub Uploads and Updates](docs/github.md): Initial push, subsequent updates, and releases.
- [Repository Readiness](docs/repository-readiness.md): Repository structure and completed verification.
- [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), and [Changelog](CHANGELOG.md).

## Data and licensing

Actual databases, backups, email summaries, screenshots, exports, temporary scripts, and local investigation reports stay on your machine. `npm run package:source` creates a source archive that excludes those files and includes a file manifest and SHA-256 checksum.

All rights are currently reserved for the project's own code; see [LICENSE](LICENSE). See [NOTICE](NOTICE.md) for third-party and fixture notices. The rights holder may choose an open-source license separately; publication on GitHub does not change the current license.
