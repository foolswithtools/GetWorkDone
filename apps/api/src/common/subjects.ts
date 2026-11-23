// Allowlists of OIDC subjects (`sub`) from the environment (GWP#9): SYNTHETIC_SUBJECTS, whose traffic the
// RED metrics label synthetic="true" (red.ts), and FAULT_ADMIN_SUBJECTS, who may set a fault on the dev
// drill route (modules/fault). Each is a comma-separated list; entries are trimmed and empty ones
// dropped. A subject with whitespace inside, or longer than 255 characters, stops startup.

const MAX_SUBJECT_LENGTH = 255;

export function subjectsFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const subjects = new Set<string>();
  for (const raw of (env[name] ?? '').split(',')) {
    const subject = raw.trim();
    if (subject === '') continue;
    if (/\s/.test(subject)) throw new Error(`${name} holds a subject with whitespace inside: ${JSON.stringify(subject)}`);
    if (subject.length > MAX_SUBJECT_LENGTH) throw new Error(`${name} holds a subject longer than ${MAX_SUBJECT_LENGTH} characters`);
    subjects.add(subject);
  }
  return subjects;
}
