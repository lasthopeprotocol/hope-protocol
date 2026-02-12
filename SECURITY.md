# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in the $HOPE protocol, please report it responsibly.

**DO NOT** open a public GitHub issue for security vulnerabilities.

## Scope

| In Scope | Out of Scope |
|----------|-------------|
| PnL calculation bypass | UI/UX bugs |
| Anti-abuse mechanism circumvention | Feature requests |
| Unauthorized fund access | Performance issues |
| Smart contract interaction exploits | Documentation typos |

## Security Measures

- All secrets managed via environment variables
- `.gitignore` configured to block sensitive files
- Gas reserve prevents wallet drainage
- Swap slippage capped at 5%
- Transaction confirmation required before proceeding
- Anti-MEV jitter on cycle timing
- Dedicated bot wallet isolated from personal funds

## Best Practices for Operators

1. **Never** share or commit private keys
2. Use a **dedicated wallet** for the bot only
3. Keep **minimal SOL** on the bot wallet
4. Use a **premium RPC** (Helius, QuickNode) for reliability
5. Monitor bot logs via PM2
6. Rotate RPC API keys periodically
