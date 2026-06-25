import { CodeBlock } from "claudius";

export const Shell = () => (
  <div style={{ maxWidth: 640 }}>
    <CodeBlock lang="bash" code={"# install deps and start the dev server\nbun install\nbun run dev"} />
  </div>
);

export const TypeScript = () => (
  <div style={{ maxWidth: 640 }}>
    <CodeBlock
      lang="ts"
      code={
        'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n\nconst msg = greet("Claudius");'
      }
    />
  </div>
);

export const Json = () => (
  <div style={{ maxWidth: 640 }}>
    <CodeBlock
      lang="json"
      code={'{\n  "name": "claudius",\n  "private": true,\n  "scripts": { "dev": "next dev" }\n}'}
    />
  </div>
);
