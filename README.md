# Simple SSH

Cliente SSH simples no estilo MobaXterm: abas de terminal, sessões em pastas e explorer SFTP lateral.

```
npm install
npm start          # --dev abre o DevTools
npm run dist       # gera dist/Simple-SSH-Setup-<versão>.exe (instala no usuário, sem admin, com atalho na área de trabalho)
npm test           # self-check do import do MobaXterm (node mobaimport.js [arquivos...] mostra o resumo)
```

- Conexões ficam em `%APPDATA%/Simple SSH/connections.json`, que guarda só o caminho da chave (`%USERPROFILE%` é expandido).
- Host keys são verificadas no `~/.ssh/known_hosts`, o mesmo do OpenSSH.
- Exportar gera um `.mxtsessions` (abre aqui e no MobaXterm). Vai só o caminho da chave, nunca a chave.
- Importar aceita `.mxtsessions` (exportado) e `MobaXterm.ini`, só sessões SSH. Duplicata = pasta + host + usuário.
- No terminal, selecionar copia, o botão direito cola e Ctrl+Shift+C/V também funcionam. Com a sessão caída, `R` reconecta.
- No explorer, dois cliques num arquivo abrem no VS Code e cada save sobe o arquivo de volta.

## IA (Claude Code / Codex)

`mcp.js` é um servidor MCP que dá à IA as ferramentas `list_connections` e `run` (comando no servidor, com `stdin` opcional para escrever arquivo). Ele lê o mesmo `connections.json` e só conecta em host que já está no `known_hosts`: conecte uma vez pelo app para confiar.

```
claude mcp add -s user simple-ssh -- node C:\caminho\sshforge\mcp.js
```

No Codex, em `~/.codex/config.toml`:

```toml
[mcp_servers.simple-ssh]
command = "node"
args = ['C:\caminho\sshforge\mcp.js']
```
