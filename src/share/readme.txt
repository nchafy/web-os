web-os /usr/share

logo.png   the 16x16 logo, as a real PNG. Nothing here decodes PNG: it is the opaque
           binary a typed clipboard has to carry without touching.
logo.rgba  the same image as a DOBJ_BITMAP payload - [u32 w][u32 h] then RGBA8 rows,
           top row first - which is the one image format a display list can draw.
readme.txt this file, which is what the TEXT format carries.
