// Pin sqlite so every CLI command (up / ps / approve / resume) shares one store.
export default { backend: "sqlite" as const };
