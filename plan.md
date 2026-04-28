Build phases
Phase	What gets built	Key challenge
1	Extension scaffold, WebView shell, file I/O, message passing	VSCode API wiring
2	CM6 editor with basic LaTeX syntax highlighting	bundler setup (esbuild)
3	Text decorations (\textbf, \textit, \section etc.)	cursor-aware decoration logic
4	Math rendering via KaTeX ($...$, $$...$$)	async rendering, escaped \$
5	Environment decorations (lists, figure, table)	multi-line range tracking
6	Toolbar + VSCode theme integration	CSS variables from VSCode