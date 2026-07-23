# Security Policy

## Reporting a vulnerability

Please do not open a public Issue for a suspected vulnerability or exposed
credential. Use GitHub's private vulnerability reporting for the OpenMozi
repository so the report and any proof remain private until a fix is ready.

Include the affected version or commit, the reachable execution path, expected
impact, and the smallest safe reproduction you can provide. Do not include
real user data or active credentials.

## Scope

OpenMozi can execute commands, access configured workspaces, call external
providers, and control optional local services. Reports involving permission
enforcement, path boundaries, tenant or session isolation, secret handling,
artifact delivery, managed workers, or update integrity are especially useful.

The project does not operate a hosted MOZI service. Provider accounts, local
machine configuration, and third-party services remain under the operator's
control and their own security policies.
