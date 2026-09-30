// Canonical shadcn/ui utils.ts (new-york-v4 registry): the generated
// src/components/ui/* primitives import `cn` from the "cn" package
// directly, so this re-export keeps `@/lib/utils` as the single alias
// the rest of the app (non-shadcn code) uses for the same helper.
export { cn } from 'cn';
