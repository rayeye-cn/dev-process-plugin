---
applyTo: "src/auth/**,src/update/**"
---

# Security review (go through every item for changes on these paths)

- **Credentials**: tokens are stored only through the credential store; never in logs or error messages.
- **Update feed**: only https feeds; never allow a downgrade.
