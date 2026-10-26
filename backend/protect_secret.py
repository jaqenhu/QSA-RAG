"""Windows CurrentUser DPAPI. Secret material is read from stdin, never argv."""
import base64
import ctypes
import json
import sys
from ctypes import wintypes


class Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def protect(mode, value):
    if sys.platform != "win32":
        raise RuntimeError("Windows DPAPI required")
    raw = value.encode("utf-8") if mode == "encrypt" else base64.b64decode(value, validate=True)
    buffer = ctypes.create_string_buffer(raw)
    source = Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    library = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    operation = library.CryptProtectData if mode == "encrypt" else library.CryptUnprotectData
    operation.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                          ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    operation.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if not operation(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise RuntimeError("DPAPI unavailable")
    try:
        result = ctypes.string_at(output.data, output.size)
        return base64.b64encode(result).decode("ascii") if mode == "encrypt" else result.decode("utf-8")
    finally:
        kernel.LocalFree(output.data)
        ctypes.memset(buffer, 0, len(buffer))


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        if request["mode"] not in ("encrypt", "decrypt"):
            raise ValueError()
        print(json.dumps({"ok": True, "value": protect(request["mode"], request["value"])}))
    except Exception:
        print(json.dumps({"ok": False}))
        sys.exit(1)
