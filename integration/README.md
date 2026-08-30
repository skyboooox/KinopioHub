# Cross-repository integration tests

This directory is reserved for tests that exercise two or more KinopioHub repositories together. Unit and package-specific tests remain in their owning repositories.

Every integration scenario should record:

- repository versions or commit hashes;
- NATS Server or `Kinopio-server` version;
- transports and authentication modes;
- expected subject and payload behavior;
- a deterministic setup and teardown path.

No cross-repository test has been declared authoritative yet. The initial CI validates workspace metadata only.
