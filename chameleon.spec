# -*- mode: python ; coding: utf-8 -*-
import sys
import os

block_cipher = None

# Paths
ROOT = os.path.dirname(os.path.abspath(SPEC))
BACKEND = os.path.join(ROOT, 'backend')
STATIC = os.path.join(BACKEND, 'static')

a = Analysis(
    [os.path.join(BACKEND, 'main.py')],
    pathex=[BACKEND],
    binaries=[],
    datas=[
        (STATIC, 'static'),  # Include built frontend
    ],
    hiddenimports=[
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'uvicorn.lifespan.off',
        'playwright',
        'playwright.sync_api',
        'playwright.async_api',
        'fastapi',
        'starlette',
        'pydantic',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='Chameleon',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # Show console for browser download progress
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,  # Add icon if you have one
)
