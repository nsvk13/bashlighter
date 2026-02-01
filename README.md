# Bash Highlighter for CI/CD

VSCode extension that provides bash syntax highlighting inside GitHub Actions and GitLab CI workflow files.

![VSCode](https://img.shields.io/badge/VSCode-1.85+-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Smart CI detection** — analyzes YAML structure, not filenames. Works with any path: `.gitlab-ci.yml`, `ci/deploy.yml`, `.gitlab/ci/build.yaml`, etc.
- **Bash highlighting** in `run:`, `script:`, `before_script:`, `after_script:` blocks
- **Multiline support** — handles `|` and `>` YAML block scalars
- **GitHub expressions** — recognizes `${{ }}` syntax

## Highlighted elements

| Element | Examples |
|---------|----------|
| Commands | `echo`, `cd`, `mkdir`, `npm`, `docker` |
| Keywords | `if`, `then`, `else`, `fi`, `for`, `while`, `case` |
| Variables | `$VAR`, `${VAR:-default}`, `$1`, `$@` |
| Strings | `"double quoted"`, `'single quoted'` |
| Operators | `&&`, `\|\|`, `>`, `>>`, `\|`, `;` |
| Comments | `# comment` |
| GitHub expressions | `${{ github.sha }}`, `${{ secrets.TOKEN }}` |

## Supported CI systems

**GitHub Actions**
- `.github/workflows/*.yml`
- Any YAML containing `jobs`, `runs-on`, `steps` structure

**GitLab CI**
- `.gitlab-ci.yml`
- Any YAML containing `stages`, `script`, `image` structure
- Works with `include:` files at any path

## Installation

### From Marketplace

Search for "Bash Highlighter for CI/CD" in VSCode Extensions.

### From VSIX

```bash
npm install
npm run build
npm run package
code --install-extension bashlighter-0.1.0.vsix
```

### Development

```bash
git clone https://github.com/nsvk13/bashlighter
cd bashlighter
npm install
npm run build:dev
# Press F5 in VSCode to launch Extension Development Host
```

## License

MIT
