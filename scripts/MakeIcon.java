import javax.imageio.ImageIO;
import java.awt.AlphaComposite;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.File;

/**
 * The app icon is the mark itself, on a transparent square.
 * usage: java scripts/MakeIcon.java [logo.png] [out.png]
 */
public class MakeIcon {
    public static void main(String[] args) throws Exception {
        File logoFile = new File(args.length > 0 ? args[0] : "src/renderer/assets/logo.png");
        File out = new File(args.length > 1 ? args[1] : "build/icon.png");
        int size = 512;

        BufferedImage logo = ImageIO.read(logoFile);
        BufferedImage icon = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = icon.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        int box = Math.round(size * 0.72f);
        float scale = Math.min(box / (float) logo.getWidth(), box / (float) logo.getHeight());
        int w = Math.round(logo.getWidth() * scale), h = Math.round(logo.getHeight() * scale);
        g.setComposite(AlphaComposite.SrcOver);
        g.drawImage(logo, (size - w) / 2, (size - h) / 2, w, h, null);
        g.dispose();

        out.getAbsoluteFile().getParentFile().mkdirs();
        ImageIO.write(icon, "png", out);
        System.out.println("wrote " + out);
    }
}
