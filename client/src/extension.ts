import * as vscode from 'vscode';
import { parseDocument, Scalar, YAMLMap, YAMLSeq, isScalar, isSeq, isMap, Pair } from 'yaml';

// ===================== DETECTION =====================

enum CIType {
  GITLAB_CI = 'gitlab-ci',
  GITHUB_ACTIONS = 'github-actions',
  UNKNOWN = 'unknown',
}

const GITHUB_INDICATORS = {
  strong: ['jobs', 'runs-on', 'on', 'uses', 'workflow_dispatch', 'workflow_call'],
  medium: ['steps', 'with', 'run', 'name', 'if', 'needs', 'strategy', 'matrix', 'container', 'services'],
  weak: ['env', 'timeout-minutes', 'continue-on-error', 'permissions', 'concurrency', 'defaults', 'outputs', 'secrets'],
};

const GITLAB_INDICATORS = {
  strong: ['stages', 'before_script', 'after_script', '.gitlab-ci', 'include', 'extends'],
  medium: ['script', 'image', 'artifacts', 'cache', 'rules', 'only', 'except', 'tags', 'variables'],
  weak: ['when', 'allow_failure', 'dependencies', 'needs', 'trigger', 'parallel'],
};

const GITHUB_BASH_KEYS = ['run', 'script'];
const GITLAB_BASH_KEYS = ['script', 'before_script', 'after_script'];

function extractAllKeys(obj: unknown, depth = 0, maxDepth = 5): Set<string> {
  const keys = new Set<string>();
  if (depth > maxDepth || obj === null || obj === undefined) return keys;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      for (const key of extractAllKeys(item, depth + 1, maxDepth)) keys.add(key);
    }
  } else if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      keys.add(key);
      for (const nestedKey of extractAllKeys(value, depth + 1, maxDepth)) keys.add(nestedKey);
    }
  }
  return keys;
}

function detectCIType(content: string): { ciType: CIType; confidence: number } {
  try {
    const doc = parseDocument(content);
    const parsed = doc.toJS();
    if (!parsed || typeof parsed !== 'object') return { ciType: CIType.UNKNOWN, confidence: 0 };

    const keys = extractAllKeys(parsed);

    const calcScore = (ind: typeof GITHUB_INDICATORS) => {
      let s = 0;
      for (const k of ind.strong) if (keys.has(k)) s += 1.0;
      for (const k of ind.medium) if (keys.has(k)) s += 0.6;
      for (const k of ind.weak) if (keys.has(k)) s += 0.3;
      return s;
    };
    const maxS = (ind: typeof GITHUB_INDICATORS) =>
      ind.strong.length * 1.0 + ind.medium.length * 0.6 + ind.weak.length * 0.3;

    const ghConf = calcScore(GITHUB_INDICATORS) / maxS(GITHUB_INDICATORS);
    const glConf = calcScore(GITLAB_INDICATORS) / maxS(GITLAB_INDICATORS);

    if (ghConf > glConf && ghConf >= 0.15) return { ciType: CIType.GITHUB_ACTIONS, confidence: ghConf };
    if (glConf > ghConf && glConf >= 0.15) return { ciType: CIType.GITLAB_CI, confidence: glConf };
    if (ghConf >= 0.15) return { ciType: CIType.GITHUB_ACTIONS, confidence: ghConf };
    if (glConf >= 0.15) return { ciType: CIType.GITLAB_CI, confidence: glConf };
    return { ciType: CIType.UNKNOWN, confidence: 0 };
  } catch {
    return { ciType: CIType.UNKNOWN, confidence: 0 };
  }
}

// ===================== BASH REGION EXTRACTION =====================

interface BashRegion {
  content: string;
  lineOffsets: number[]; // Document offset for start of each line in content
}

function extractRegionFromScalar(scalar: Scalar, docContent: string): BashRegion | null {
  const value = scalar.value;
  if (typeof value !== 'string' || !value.trim() || !scalar.range) return null;

  const [start] = scalar.range;
  const valueLines = value.split('\n');
  const lineOffsets: number[] = [];

  if (scalar.type === 'BLOCK_LITERAL' || scalar.type === 'BLOCK_FOLDED') {
    // Skip past the | or > indicator line
    let pos = start;
    while (pos < docContent.length && docContent[pos] !== '\n') pos++;
    pos++; // skip newline

    // For each line in the value, find its position in document
    for (const line of valueLines) {
      if (line.length === 0) {
        // Empty line - find next newline
        lineOffsets.push(pos);
        while (pos < docContent.length && docContent[pos] !== '\n') pos++;
        pos++;
      } else {
        // Find this line content in document (accounting for indentation)
        const idx = docContent.indexOf(line, pos);
        if (idx !== -1 && idx < pos + 100) {
          lineOffsets.push(idx);
          pos = idx + line.length;
          while (pos < docContent.length && docContent[pos] !== '\n') pos++;
          pos++;
        } else {
          lineOffsets.push(pos);
          while (pos < docContent.length && docContent[pos] !== '\n') pos++;
          pos++;
        }
      }
    }
  } else if (scalar.type === 'QUOTE_SINGLE' || scalar.type === 'QUOTE_DOUBLE') {
    // Quoted string - content starts after opening quote
    lineOffsets.push(start + 1);
  } else {
    // Plain scalar
    lineOffsets.push(start);
  }

  return { content: value, lineOffsets };
}

function extractGitHubBashRegions(content: string): BashRegion[] {
  const regions: BashRegion[] = [];
  try {
    const doc = parseDocument(content, { keepSourceTokens: true });
    const root = doc.contents;
    if (!isMap(root)) return regions;

    for (const pair of (root as YAMLMap).items) {
      if (!(pair instanceof Pair)) continue;
      const key = isScalar(pair.key) ? String((pair.key as Scalar).value) : '';
      if (key !== 'jobs') continue;

      const jobs = pair.value;
      if (!isMap(jobs)) continue;

      for (const jobPair of (jobs as YAMLMap).items) {
        if (!(jobPair instanceof Pair)) continue;
        const job = jobPair.value;
        if (!isMap(job)) continue;

        for (const jobFieldPair of (job as YAMLMap).items) {
          if (!(jobFieldPair instanceof Pair)) continue;
          const fieldKey = isScalar(jobFieldPair.key) ? String((jobFieldPair.key as Scalar).value) : '';
          if (fieldKey !== 'steps') continue;

          const steps = jobFieldPair.value;
          if (!isSeq(steps)) continue;

          for (const step of (steps as YAMLSeq).items) {
            if (!isMap(step)) continue;

            for (const stepPair of (step as YAMLMap).items) {
              if (!(stepPair instanceof Pair)) continue;
              const stepKey = isScalar(stepPair.key) ? String((stepPair.key as Scalar).value) : '';

              if (GITHUB_BASH_KEYS.includes(stepKey) && isScalar(stepPair.value)) {
                const region = extractRegionFromScalar(stepPair.value as Scalar, content);
                if (region) regions.push(region);
              }

              if (stepKey === 'with' && isMap(stepPair.value)) {
                for (const withPair of (stepPair.value as YAMLMap).items) {
                  if (!(withPair instanceof Pair)) continue;
                  const withKey = isScalar(withPair.key) ? String((withPair.key as Scalar).value) : '';
                  if (GITHUB_BASH_KEYS.includes(withKey) && isScalar(withPair.value)) {
                    const region = extractRegionFromScalar(withPair.value as Scalar, content);
                    if (region) regions.push(region);
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch { /* ignore */ }
  return regions;
}

function extractGitLabBashRegions(content: string): BashRegion[] {
  const regions: BashRegion[] = [];
  try {
    const doc = parseDocument(content, { keepSourceTokens: true });
    const root = doc.contents;
    if (!isMap(root)) return regions;

    const extractFromValue = (value: unknown) => {
      if (isSeq(value)) {
        for (const item of (value as YAMLSeq).items) {
          if (isScalar(item)) {
            const region = extractRegionFromScalar(item as Scalar, content);
            if (region) regions.push(region);
          }
        }
      } else if (isScalar(value)) {
        const region = extractRegionFromScalar(value as Scalar, content);
        if (region) regions.push(region);
      }
    };

    for (const pair of (root as YAMLMap).items) {
      if (!(pair instanceof Pair)) continue;
      const key = isScalar(pair.key) ? String((pair.key as Scalar).value) : '';
      const value = pair.value;

      if (GITLAB_BASH_KEYS.includes(key)) {
        extractFromValue(value);
      }

      if (isMap(value)) {
        for (const jobPair of (value as YAMLMap).items) {
          if (!(jobPair instanceof Pair)) continue;
          const jobKey = isScalar(jobPair.key) ? String((jobPair.key as Scalar).value) : '';
          if (GITLAB_BASH_KEYS.includes(jobKey)) {
            extractFromValue(jobPair.value);
          }
        }
      }
    }
  } catch { /* ignore */ }
  return regions;
}

// ===================== BASH TOKENIZER =====================

enum BashTokenType {
  COMMAND, BUILTIN, KEYWORD, VARIABLE, VARIABLE_SPECIAL, STRING_SINGLE, STRING_DOUBLE,
  COMMENT, OPERATOR, REDIRECT, OPTION, ARGUMENT, SUBSHELL, GITHUB_EXPRESSION, GLOB,
  ESCAPE, WHITESPACE, TEXT
}

interface BashToken {
  type: BashTokenType;
  value: string;
  offset: number;
  length: number;
}

const BASH_BUILTINS = new Set([
  'echo', 'cd', 'pwd', 'export', 'unset', 'source', 'alias', 'unalias', 'exit',
  'return', 'read', 'declare', 'local', 'readonly', 'typeset', 'eval', 'exec',
  'set', 'shift', 'trap', 'wait', 'bg', 'fg', 'jobs', 'kill', 'test', 'true',
  'false', 'printf', 'let', 'getopts', 'ulimit', 'umask', 'pushd', 'popd', 'dirs',
  'builtin', 'command', 'type', 'hash', 'help', 'logout', 'times', 'bind',
  'complete', 'compgen', 'compopt', 'mapfile', 'readarray', 'shopt', 'enable',
  'suspend', 'disown', 'caller', 'cat', 'mkdir', 'chmod', 'sleep',
]);

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'while', 'until',
  'do', 'done', 'in', 'function', 'select', 'time', 'coproc', '[[', ']]', '{', '}', '!',
]);

function tokenizeBash(content: string): BashToken[] {
  const tokens: BashToken[] = [];
  let pos = 0;
  let isCommandPosition = true;

  const emit = (type: BashTokenType, start: number, end: number) => {
    if (end > start) {
      tokens.push({ type, value: content.substring(start, end), offset: start, length: end - start });
    }
  };

  const isWordChar = (ch: string) => /[a-zA-Z0-9_\-.]/.test(ch);
  const isWhitespace = (ch: string) => /[ \t]/.test(ch);

  while (pos < content.length) {
    const ch = content[pos];
    const next = content[pos + 1];

    // GitHub expression ${{ }}
    if (ch === '$' && next === '{' && content[pos + 2] === '{') {
      const start = pos;
      pos += 3;
      while (pos < content.length) {
        if (content[pos] === '}' && content[pos + 1] === '}') { pos += 2; break; }
        pos++;
      }
      emit(BashTokenType.GITHUB_EXPRESSION, start, pos);
      isCommandPosition = false;
      continue;
    }

    // Variable
    if (ch === '$') {
      const start = pos;
      pos++;
      if (pos < content.length) {
        const varCh = content[pos];
        if ('?!$@*#-0123456789'.includes(varCh)) {
          pos++;
          emit(BashTokenType.VARIABLE_SPECIAL, start, pos);
          continue;
        }
        if (varCh === '{') {
          pos++;
          let depth = 1;
          while (pos < content.length && depth > 0) {
            if (content[pos] === '{') depth++;
            if (content[pos] === '}') { depth--; if (depth === 0) { pos++; break; } }
            pos++;
          }
          emit(BashTokenType.VARIABLE, start, pos);
          continue;
        }
        if (varCh === '(') {
          pos++;
          let depth = 1;
          while (pos < content.length && depth > 0) {
            if (content[pos] === '(') depth++;
            if (content[pos] === ')') { depth--; if (depth === 0) { pos++; break; } }
            pos++;
          }
          emit(BashTokenType.SUBSHELL, start, pos);
          isCommandPosition = false;
          continue;
        }
        if (/[a-zA-Z_]/.test(varCh)) {
          while (pos < content.length && /[a-zA-Z0-9_]/.test(content[pos])) pos++;
          emit(BashTokenType.VARIABLE, start, pos);
          continue;
        }
      }
      emit(BashTokenType.TEXT, start, pos);
      continue;
    }

    // Comment
    if (ch === '#') {
      const start = pos;
      while (pos < content.length && content[pos] !== '\n') pos++;
      emit(BashTokenType.COMMENT, start, pos);
      isCommandPosition = true;
      continue;
    }

    // Single-quoted string
    if (ch === "'") {
      const start = pos;
      pos++;
      while (pos < content.length && content[pos] !== "'") pos++;
      if (pos < content.length) pos++;
      emit(BashTokenType.STRING_SINGLE, start, pos);
      isCommandPosition = false;
      continue;
    }

    // Double-quoted string
    if (ch === '"') {
      const start = pos;
      pos++;
      while (pos < content.length) {
        if (content[pos] === '\\' && pos + 1 < content.length) { pos += 2; continue; }
        if (content[pos] === '"') { pos++; break; }
        pos++;
      }
      emit(BashTokenType.STRING_DOUBLE, start, pos);
      isCommandPosition = false;
      continue;
    }

    // Backtick subshell
    if (ch === '`') {
      const start = pos;
      pos++;
      while (pos < content.length && content[pos] !== '`') {
        if (content[pos] === '\\') pos++;
        pos++;
      }
      if (pos < content.length) pos++;
      emit(BashTokenType.SUBSHELL, start, pos);
      isCommandPosition = false;
      continue;
    }

    // Operators
    if (ch === '|') {
      emit(BashTokenType.OPERATOR, pos, next === '|' ? pos + 2 : pos + 1);
      pos += next === '|' ? 2 : 1;
      isCommandPosition = true;
      continue;
    }
    if (ch === '&') {
      emit(BashTokenType.OPERATOR, pos, next === '&' ? pos + 2 : pos + 1);
      pos += next === '&' ? 2 : 1;
      isCommandPosition = true;
      continue;
    }
    if (ch === ';') {
      emit(BashTokenType.OPERATOR, pos, pos + 1);
      pos++;
      isCommandPosition = true;
      continue;
    }

    // Redirection
    if (ch === '>' || ch === '<') {
      const start = pos;
      pos++;
      if (pos < content.length && (content[pos] === '>' || content[pos] === '&')) pos++;
      emit(BashTokenType.REDIRECT, start, pos);
      isCommandPosition = false;
      continue;
    }

    // Newline
    if (ch === '\n') {
      pos++;
      isCommandPosition = true;
      continue;
    }

    // Whitespace
    if (isWhitespace(ch)) {
      while (pos < content.length && isWhitespace(content[pos])) pos++;
      continue;
    }

    // Option
    if (ch === '-' && (next === '-' || /[a-zA-Z]/.test(next || ''))) {
      const start = pos;
      pos++;
      if (content[pos] === '-') pos++;
      while (pos < content.length && isWordChar(content[pos])) pos++;
      if (pos < content.length && content[pos] === '=') pos++;
      emit(BashTokenType.OPTION, start, pos);
      isCommandPosition = false;
      continue;
    }

    // Word (command or argument)
    if (isWordChar(ch) || ch === '/' || ch === '~' || ch === '.') {
      const start = pos;
      while (pos < content.length && (isWordChar(content[pos]) || '/~.=:+'.includes(content[pos]))) pos++;
      const word = content.substring(start, pos);

      if (BASH_KEYWORDS.has(word)) {
        emit(BashTokenType.KEYWORD, start, pos);
        if (['then', 'do', 'else', '{', '('].includes(word)) isCommandPosition = true;
      } else if (isCommandPosition) {
        if (BASH_BUILTINS.has(word)) {
          emit(BashTokenType.BUILTIN, start, pos);
        } else {
          emit(BashTokenType.COMMAND, start, pos);
        }
        isCommandPosition = false;
      } else {
        emit(BashTokenType.ARGUMENT, start, pos);
      }
      continue;
    }

    // Glob
    if (ch === '*' || ch === '?') {
      emit(BashTokenType.GLOB, pos, pos + 1);
      pos++;
      isCommandPosition = false;
      continue;
    }
    if (ch === '[') {
      const start = pos;
      pos++;
      while (pos < content.length && content[pos] !== ']') pos++;
      if (pos < content.length) pos++;
      emit(BashTokenType.GLOB, start, pos);
      isCommandPosition = false;
      continue;
    }

    // Parentheses/braces
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      emit(BashTokenType.KEYWORD, pos, pos + 1);
      pos++;
      if (ch === '(' || ch === '{') isCommandPosition = true;
      continue;
    }

    pos++;
  }

  return tokens;
}

// ===================== POSITION MAPPING =====================

// Convert token offset in scalar.value to document offset
function mapTokenToDocument(
  tokenOffset: number,
  tokenLength: number,
  content: string,
  lineOffsets: number[]
): { start: number; end: number } | null {
  // Find which line this token is on in the content
  const lines = content.split('\n');
  let currentOffset = 0;
  let lineIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineEnd = currentOffset + lines[i].length;
    if (tokenOffset >= currentOffset && tokenOffset <= lineEnd) {
      lineIndex = i;
      break;
    }
    currentOffset = lineEnd + 1; // +1 for newline
  }

  if (lineIndex >= lineOffsets.length) return null;

  // Calculate column within this line
  let offsetInLine = tokenOffset;
  for (let i = 0; i < lineIndex; i++) {
    offsetInLine -= lines[i].length + 1;
  }

  const docStart = lineOffsets[lineIndex] + offsetInLine;

  // Handle multi-line tokens
  let docEnd = docStart + tokenLength;

  // Check if token spans multiple lines
  const tokenEndOffset = tokenOffset + tokenLength;
  let endLineIndex = lineIndex;
  currentOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = currentOffset + lines[i].length;
    if (tokenEndOffset >= currentOffset && tokenEndOffset <= lineEnd + 1) {
      endLineIndex = i;
      break;
    }
    currentOffset = lineEnd + 1;
  }

  if (endLineIndex > lineIndex && endLineIndex < lineOffsets.length) {
    // Multi-line token - just use first line for now
    docEnd = lineOffsets[lineIndex] + lines[lineIndex].length;
  }

  return { start: docStart, end: docEnd };
}

// ===================== DECORATION TYPES =====================

const decorationTypes: Map<BashTokenType, vscode.TextEditorDecorationType> = new Map();

function createDecorationTypes() {
  decorationTypes.set(BashTokenType.COMMAND, vscode.window.createTextEditorDecorationType({ color: '#DCDCAA' }));
  decorationTypes.set(BashTokenType.BUILTIN, vscode.window.createTextEditorDecorationType({ color: '#DCDCAA' }));
  decorationTypes.set(BashTokenType.KEYWORD, vscode.window.createTextEditorDecorationType({ color: '#C586C0' }));
  decorationTypes.set(BashTokenType.VARIABLE, vscode.window.createTextEditorDecorationType({ color: '#9CDCFE' }));
  decorationTypes.set(BashTokenType.VARIABLE_SPECIAL, vscode.window.createTextEditorDecorationType({ color: '#9CDCFE' }));
  decorationTypes.set(BashTokenType.STRING_SINGLE, vscode.window.createTextEditorDecorationType({ color: '#CE9178' }));
  decorationTypes.set(BashTokenType.STRING_DOUBLE, vscode.window.createTextEditorDecorationType({ color: '#CE9178' }));
  decorationTypes.set(BashTokenType.COMMENT, vscode.window.createTextEditorDecorationType({ color: '#6A9955' }));
  decorationTypes.set(BashTokenType.OPERATOR, vscode.window.createTextEditorDecorationType({ color: '#D4D4D4' }));
  decorationTypes.set(BashTokenType.REDIRECT, vscode.window.createTextEditorDecorationType({ color: '#D4D4D4' }));
  decorationTypes.set(BashTokenType.OPTION, vscode.window.createTextEditorDecorationType({ color: '#9CDCFE' }));
  decorationTypes.set(BashTokenType.GITHUB_EXPRESSION, vscode.window.createTextEditorDecorationType({ color: '#4EC9B0' }));
  decorationTypes.set(BashTokenType.SUBSHELL, vscode.window.createTextEditorDecorationType({ color: '#4EC9B0' }));
  decorationTypes.set(BashTokenType.GLOB, vscode.window.createTextEditorDecorationType({ color: '#D16969' }));
  decorationTypes.set(BashTokenType.ARGUMENT, vscode.window.createTextEditorDecorationType({ color: '#9CDCFE' }));
}

// ===================== HIGHLIGHTER =====================

let outputChannel: vscode.OutputChannel;
let updateTimeout: NodeJS.Timeout | undefined;

const SUPPORTED_LANGUAGES = ['yaml', 'github-actions-workflow', 'gitlab-ci', 'azure-pipelines'];

function debounceUpdate(editor: vscode.TextEditor) {
  if (updateTimeout) clearTimeout(updateTimeout);
  updateTimeout = setTimeout(() => updateDecorations(editor), 100);
}

function updateDecorations(editor: vscode.TextEditor) {
  if (!SUPPORTED_LANGUAGES.includes(editor.document.languageId)) return;

  const content = editor.document.getText();
  const detection = detectCIType(content);

  outputChannel.appendLine(`[BashHighlighter] Processing: ${editor.document.fileName}`);
  outputChannel.appendLine(`[BashHighlighter] Detected: ${detection.ciType} (confidence: ${detection.confidence.toFixed(2)})`);

  // Clear all decorations
  for (const decType of decorationTypes.values()) {
    editor.setDecorations(decType, []);
  }

  if (detection.ciType === CIType.UNKNOWN) return;

  const regions = detection.ciType === CIType.GITHUB_ACTIONS
    ? extractGitHubBashRegions(content)
    : extractGitLabBashRegions(content);

  outputChannel.appendLine(`[BashHighlighter] Found ${regions.length} bash region(s)`);

  const decorationsByType: Map<BashTokenType, vscode.DecorationOptions[]> = new Map();
  for (const type of decorationTypes.keys()) {
    decorationsByType.set(type, []);
  }

  for (const region of regions) {
    const tokens = tokenizeBash(region.content);

    for (const token of tokens) {
      if (!decorationTypes.has(token.type)) continue;

      const mapped = mapTokenToDocument(token.offset, token.length, region.content, region.lineOffsets);
      if (!mapped) continue;

      const startPos = editor.document.positionAt(mapped.start);
      const endPos = editor.document.positionAt(mapped.end);
      const range = new vscode.Range(startPos, endPos);

      decorationsByType.get(token.type)!.push({ range });
    }
  }

  let total = 0;
  for (const [type, decorations] of decorationsByType) {
    if (decorations.length > 0) {
      editor.setDecorations(decorationTypes.get(type)!, decorations);
      total += decorations.length;
    }
  }

  outputChannel.appendLine(`[BashHighlighter] Applied ${total} decorations`);
}

// ===================== EXTENSION ACTIVATION =====================

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Bash Highlighter');
  outputChannel.appendLine('[BashHighlighter] Extension activating...');

  createDecorationTypes();

  const editor = vscode.window.activeTextEditor;
  if (editor) updateDecorations(editor);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(e => { if (e) updateDecorations(e); })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      const ed = vscode.window.activeTextEditor;
      if (ed && e.document === ed.document) debounceUpdate(ed);
    })
  );

  context.subscriptions.push({
    dispose: () => { for (const d of decorationTypes.values()) d.dispose(); }
  });

  outputChannel.appendLine('[BashHighlighter] Extension activated!');
}

export function deactivate() {
  if (outputChannel) outputChannel.dispose();
}
