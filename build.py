#!/usr/bin/env python3
"""Build the site from src/ into public/index.html.

One self-contained file: the CSS and the client script are inlined, and the
game state arrives at runtime over a websocket, so there is nothing to bake in.

  python3 build.py
"""

import pathlib

HERE = pathlib.Path(__file__).parent
SRC = HERE / "src"


def main():
    css = (SRC / "styles.css").read_text(encoding="utf-8")
    js = (SRC / "app.js").read_text(encoding="utf-8")

    public = HERE / "public"
    public.mkdir(exist_ok=True)

    (public / "index.html").write_text(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '<meta name="color-scheme" content="dark">\n'
        '<meta name="theme-color" content="#141420">\n'
        "<title>Matilija Games</title>\n"
        f'<style id="app-css">{css}</style>\n</head>\n<body>\n'
        '<div id="root"></div>\n'
        f'<script id="app-js">{js}</script>\n'
        "</body>\n</html>\n",
        encoding="utf-8",
    )

    kb = (public / "index.html").stat().st_size / 1024
    print(f"public/index.html {kb:8.1f} KB")


if __name__ == "__main__":
    main()
