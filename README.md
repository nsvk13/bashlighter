# Bash Highlighter for CI/CD

VSCode extension for bash syntax highlighting in GitHub Actions and GitLab CI files.

![VSCode](https://img.shields.io/badge/VSCode-1.85+-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- Automatic CI/CD file detection by YAML structure (not by filename)
- Bash script highlighting in `run:`, `script:`, `before_script:`, `after_script:` blocks
- Multiline block support (`|`, `>`)
- GitHub expressions recognition (`${{ }}`)

## What gets highlighted

| Element | Examples |
|---------|----------|
| Commands | `echo`, `cd`, `mkdir`, `npm` |
| Builtins | `if`, `for`, `while`, `case` |
| Variables | `$VAR`, `${VAR:-default}` |
| Strings | `"quoted"`, `'single'` |
| Operators | `&&`, `\|\|`, `>`, `\|` |
| Comments | `# comment` |
| GitHub expressions | `${{ github.sha }}` |

## Installation

### From VSIX

```bash
npm install
npm run build
npm run package
code --install-extension bashlighter-0.1.0.vsix
```

### For development

1. Clone the repository
2. `npm install`
3. `npm run build:dev`
4. Press F5 in VSCode to launch Extension Development Host

## Supported files

**GitHub Actions:**
- `.github/workflows/*.yml`
- Any YAML with `jobs`, `runs-on`, `steps`

**GitLab CI:**
- `.gitlab-ci.yml`
- Any YAML with `stages`, `script`, `image`

Detection works by analyzing structure, not filename.

## License

MIT
