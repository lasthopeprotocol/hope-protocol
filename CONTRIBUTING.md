# Contributing to $HOPE Protocol

We welcome contributions! Here's how to get involved.

## Development Setup

```bash
git clone https://github.com/lasthopeprotocol/hope-protocol.git
cd hope-protocol/bot
npm install
cp .env.example .env
# Configure your .env file
npm run dev
```

## Code Style

- TypeScript strict mode
- ES2022 target
- Meaningful variable names
- JSDoc comments on public functions
- Error handling on all async operations

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Commit Convention

```
feat: add new feature
fix: fix a bug
docs: documentation changes
refactor: code refactoring
test: add or update tests
chore: maintenance tasks
```

## Important

- **Never** include secrets, API keys, or private keys in commits
- Test all changes locally before submitting PR
- Keep PRs focused — one feature/fix per PR
