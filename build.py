"""
Build script for WAF Bypass Proxy standalone exe.
Run this to:
1. Build React frontend
2. Bundle everything with PyInstaller
"""

import subprocess
import sys
import os
import shutil

# Paths
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(ROOT_DIR, "frontend")
BACKEND_DIR = os.path.join(ROOT_DIR, "backend")
DIST_DIR = os.path.join(ROOT_DIR, "dist")

def run(cmd, cwd=None):
    print(f"\n>>> {cmd}")
    result = subprocess.run(cmd, shell=True, cwd=cwd)
    if result.returncode != 0:
        print(f"Command failed with code {result.returncode}")
        sys.exit(1)

def main():
    print("=" * 50)
    print("WAF Bypass Proxy - Build Script")
    print("=" * 50)

    # Step 1: Build frontend
    print("\n[1/4] Building React frontend...")
    run("npm run build", cwd=FRONTEND_DIR)

    # Step 2: Copy frontend dist to backend/static
    print("\n[2/4] Copying frontend build to backend/static...")
    static_dest = os.path.join(BACKEND_DIR, "static")
    if os.path.exists(static_dest):
        shutil.rmtree(static_dest)
    shutil.copytree(os.path.join(FRONTEND_DIR, "dist"), static_dest)

    # Step 3: Install PyInstaller if needed
    print("\n[3/4] Ensuring PyInstaller is installed...")
    run(f"{sys.executable} -m pip install pyinstaller --quiet")

    # Step 4: Run PyInstaller
    print("\n[4/4] Building executable...")
    spec_file = os.path.join(ROOT_DIR, "waf_bypass.spec")
    run(f"pyinstaller --clean --noconfirm {spec_file}", cwd=ROOT_DIR)

    print("\n" + "=" * 50)
    print("BUILD COMPLETE!")
    print(f"Executable: {os.path.join(DIST_DIR, 'WAFBypass.exe')}")
    print("=" * 50)

if __name__ == "__main__":
    main()
