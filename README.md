# Simple SSH

Cliente SSH simples no estilo MobaXterm: abas de terminal, sessões em pastas e explorer SFTP lateral.

```
npm install
npm start          # --dev abre o DevTools
npm run dist       # gera dist/Simple-SSH-<versão>.exe (portable, sem instalar)
npm test           # self-check do import do MobaXterm (node mobaimport.js [arquivos...] mostra o resumo)
```

- Conexões ficam em `%APPDATA%/Simple SSH/connections.json`, que guarda só o caminho da chave (`%USERPROFILE%` é expandido).
- Host keys são verificadas no `~/.ssh/known_hosts`, o mesmo do OpenSSH.
- Exportar gera um `.mxtsessions` (abre aqui e no MobaXterm). Vai só o caminho da chave, nunca a chave.
- Importar aceita `.mxtsessions` (exportado) e `MobaXterm.ini`, só sessões SSH. Duplicata = pasta + host + usuário.
- No terminal, selecionar copia, o botão direito cola e Ctrl+Shift+C/V também funcionam. Com a sessão caída, `R` reconecta.
- No explorer, dois cliques num arquivo abrem no VS Code e cada save sobe o arquivo de volta.
