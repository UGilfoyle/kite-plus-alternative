import os
from PIL import Image, ImageDraw

def create_gradient_icon(size):
    # Create an image with an alpha channel
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    
    # Create gradient background
    # We will interpolate between dark blue (0, 82, 204) and purple (128, 0, 255)
    for y in range(size):
        r = int(0 + (128 - 0) * (y / size))
        g = int(82 + (0 - 82) * (y / size))
        b = int(204 + (255 - 204) * (y / size))
        for x in range(size):
            img.putpixel((x, y), (r, g, b, 255))
            
    # Apply rounded corner mask
    mask = Image.new('L', (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    radius = int(size * 0.25)
    mask_draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    
    # Create final background
    final_bg = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    final_bg.paste(img, (0, 0), mask=mask)
    
    # Draw icon logo elements
    draw = ImageDraw.Draw(final_bg)
    
    # Draw a stylized Kite shape + Plus symbol
    # Center of the icon
    cx = size / 2
    cy = size / 2
    
    # Kite diamond size scale
    scale = size / 100.0
    
    # Diamond vertices (kite shape)
    # top, right, bottom, left
    p_top = (cx - 5 * scale, cy - 25 * scale)
    p_right = (cx + 15 * scale, cy - 5 * scale)
    p_bottom = (cx - 5 * scale, cy + 15 * scale)
    p_left = (cx - 25 * scale, cy - 5 * scale)
    
    draw.polygon([p_top, p_right, p_bottom, p_left], fill=(255, 255, 255, 255))
    
    # Kite thread/tail
    draw.line([p_bottom, (cx - 15 * scale, cy + 30 * scale)], fill=(255, 255, 255, 200), width=max(1, int(2 * scale)))
    
    # Draw a small tie knot at bottom of diamond
    draw.ellipse([cx - 7 * scale, cy + 13 * scale, cx - 3 * scale, cy + 17 * scale], fill=(244, 63, 94, 255)) # rose color accent
    
    # Plus sign (+) at top right of the kite
    px = cx + 22 * scale
    py = cy - 22 * scale
    plen = 8 * scale
    pwidth = max(2, int(3 * scale))
    
    # Vertical line of plus
    draw.line([(px, py - plen), (px, py + plen)], fill=(255, 255, 255, 255), width=pwidth)
    # Horizontal line of plus
    draw.line([(px - plen, py), (px + plen, py)], fill=(255, 255, 255, 255), width=pwidth)
    
    return final_bg

def main():
    os.makedirs('icons', exist_ok=True)
    sizes = [16, 48, 128]
    for size in sizes:
        icon = create_gradient_icon(size)
        icon.save(f'icons/icon-{size}.png', 'PNG')
        print(f"Generated icons/icon-{size}.png")

if __name__ == '__main__':
    main()
