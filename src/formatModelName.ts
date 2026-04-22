const KNOWN_PREFIXES: Record<string, string> = {
  claude: "Claude",
  gpt: "GPT",
  gemini: "Gemini",
  o: "o",
};

const KNOWN_VARIANTS: Record<string, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  pro: "Pro",
  flash: "Flash",
  ultra: "Ultra",
  nano: "Nano",
  mini: "Mini",
};

function isNumeric(s: string): boolean {
  return /^\d+(\.\d+)?$/.test(s);
}

export function formatModelName(raw: string | null | undefined): string {
  if (!raw) return "";

  const parts = raw.split("-");
  if (parts.length < 2) return raw;

  const prefix = KNOWN_PREFIXES[parts[0]];
  if (!prefix) return raw;

  const tokens: string[] = [prefix];
  let i = 1;

  while (i < parts.length) {
    const variant = KNOWN_VARIANTS[parts[i]];
    if (variant) {
      tokens.push(variant);
      i++;
    } else {
      break;
    }
  }

  const versionParts: string[] = [];
  while (i < parts.length && isNumeric(parts[i])) {
    versionParts.push(parts[i]);
    i++;
  }
  if (versionParts.length > 0) {
    tokens.push(versionParts.join("."));
  }

  while (i < parts.length) {
    const variant = KNOWN_VARIANTS[parts[i]];
    if (variant) {
      tokens.push(variant);
      i++;
    } else {
      tokens.push(parts[i]);
      i++;
    }
  }

  return tokens.join(" ");
}
