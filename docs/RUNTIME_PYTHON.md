# Runtime Python sem VENV

O Codex Usage Monitor usa exclusivamente um Python já instalado e preparado na
máquina. Nenhum script cria ambiente virtual ou instala pacotes.

## Ordem de seleção do Python

Os scripts tentam, nesta ordem:

1. Caminho definido em `CODEX_USAGE_PYTHON`;
2. Python Launcher do Windows: `py -3`;
3. Comando `python`;
4. Comando `python3`.

O runtime precisa ser Python 3.11 ou superior.

## Seleção explícita

Para escolher uma instalação específica:

```powershell
$env:CODEX_USAGE_PYTHON = "C:\Python311\python.exe"
.\scripts\validate_environment.ps1
```

Para persistir para o usuário atual:

```powershell
[Environment]::SetEnvironmentVariable(
    "CODEX_USAGE_PYTHON",
    "C:\Python311\python.exe",
    "User"
)
```

Abra um novo PowerShell após persistir a variável.

## Bibliotecas obrigatórias

O mesmo Python selecionado precisa conter:

- `websocket-client`
- `psutil`
- `tzdata`

O arquivo `requirements.txt` é apenas um manifesto de versões esperadas. Os
scripts do projeto não executam `pip`.

## Validação

```powershell
.\scripts\validate_environment.ps1
.\scripts\test.ps1
```

Se uma biblioteca estiver ausente, o processo é interrompido com uma mensagem
indicando o pacote faltante.
