"""PyInstaller entry point; an absolute import because a frozen script has no package context."""
from aw_telegram.main import main

raise SystemExit(main())
