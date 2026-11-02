package com.chuju.apiforge;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * .class 文件的结构化读取（JVMS 常量池 + 类/字段/方法属性）。
 *
 * 源码路径用 JavaParser；jar 模式没有源码，Spring 的映射注解是
 * RuntimeVisible(Invisible)Annotations 编进 class 文件的，读常量池就能拿到。
 * 不引 ASM——JarArtifactResolver 当年立的原则不变：shade 后单文件可用。
 *
 * 只做「读取」，不做业务判断：产出 ClassInfo 原始结构（注解的名值对、字段、
 * 方法、参数注解、方法体字节），Controller/DTO 落判全在 JarClassParser——
 * 读取层坏了报 IOException，业务层不该让它背锅。
 *
 * 读到方法体字节就停（Code 的子属性、StackMapTable 等按长度跳过），
 * 不逐指令验证——方法体的消费只有 JarClassParser 的字段使用扫描，
 * 那里有逐指令的越界与 tag 校验，错位最多多扫几条，不会崩。
 */
final class ClassBytecodeReader {
    private ClassBytecodeReader() {
    }

    /** 一个注解：类型简名（NotNull）+ 具名属性（名 → 值文本）。值读不出的属性不进来 */
    static final class Anno {
        final String name;
        final Map<String, String> attrs = new LinkedHashMap<>();

        Anno(String name) {
            this.name = name;
        }

        /** @NotNull / @Size(max=64) 形状。对齐源码注解 toString 的观感（流水/注解串用） */
        String text() {
            if (attrs.isEmpty()) return "@" + name;
            StringBuilder sb = new StringBuilder("@").append(name).append('(');
            boolean first = true;
            for (Map.Entry<String, String> e : attrs.entrySet()) {
                if (!first) sb.append(", ");
                sb.append(e.getKey()).append('=').append(e.getValue());
                first = false;
            }
            return sb.append(')').toString();
        }

        String attr(String key, String dflt) {
            String v = attrs.get(key);
            return v != null ? v : dflt;
        }
    }

    static final class FieldInfo {
        final int flags;
        final String name;
        final String descriptor;
        /** 泛型实参只活在 Signature 里（擦除后描述符是裸 List），无属性为 null */
        final String signature;
        final List<Anno> annos;

        FieldInfo(int flags, String name, String descriptor, String signature, List<Anno> annos) {
            this.flags = flags;
            this.name = name;
            this.descriptor = descriptor;
            this.signature = signature;
            this.annos = annos;
        }
    }

    static final class MethodInfo {
        final int flags;
        final String name;
        final String descriptor;
        /** 方法签名：(参数类型)返回类型，参数/返回的泛型实参在这里；无属性为 null */
        final String signature;
        final List<Anno> annos;
        /** 与描述符参数按下标对齐的参数注解（可见+不可见两份合并）；无属性为空 */
        final List<List<Anno>> paramAnnos;
        /** 方法体字节（Code 属性）；abstract/native 为 null。字段使用扫描的原料 */
        final byte[] code;

        MethodInfo(int flags, String name, String descriptor, String signature,
                   List<Anno> annos, List<List<Anno>> paramAnnos, byte[] code) {
            this.flags = flags;
            this.name = name;
            this.descriptor = descriptor;
            this.signature = signature;
            this.annos = annos;
            this.paramAnnos = paramAnnos;
            this.code = code;
        }
    }

    static final class ClassInfo {
        final int access;
        final String thisName;
        final String superName;
        final List<String> ifaces = new ArrayList<>();
        final List<Anno> annos = new ArrayList<>();
        final List<FieldInfo> fields = new ArrayList<>();
        final List<MethodInfo> methods = new ArrayList<>();
        // 常量池视图：fieldRefOf 要用，随 parse 结果一起活着
        private final String[] utf8;
        private final int[] refClass;   // tag 9/10/11/17/18 → class_index
        private final int[] refNat;     // 同上 → name_and_type_index
        private final int[] natName;    // tag 12 → name_index
        private final int[] natDesc;    // tag 12 → descriptor_index
        private final String[] classNames; // tag 7 解析好的内部名
        private final Object[] numConsts;  // tag 3/4/5/6 的 Integer/Float/Long/Double

        ClassInfo(int access, String thisName, String superName,
                  String[] utf8, int[] refClass, int[] refNat, int[] natName, int[] natDesc,
                  String[] classNames, Object[] numConsts) {
            this.access = access;
            this.thisName = thisName;
            this.superName = superName;
            this.utf8 = utf8;
            this.refClass = refClass;
            this.refNat = refNat;
            this.natName = natName;
            this.natDesc = natDesc;
            this.classNames = classNames;
            this.numConsts = numConsts;
        }

        /**
         * 常量池下标 → Fieldref 的 [owner 内部名, 字段名, 描述符]；不是 Fieldref 返回 null。
         * 方法体的 getfield/putfield 指令数就一个 u2 常量池下标，错位时指到别的 tag——
         * 这里按 tag 挡一道，业务扫描侧不用再猜。
         */
        String[] fieldRefOf(int cpIndex) {
            if (cpIndex <= 0 || cpIndex >= refClass.length) return null;
            int cls = refClass[cpIndex];
            int nat = refNat[cpIndex];
            if (cls <= 0 || nat <= 0) return null;
            String owner = classNames[cls];
            if (owner == null) return null;
            int n = natName[nat];
            int d = natDesc[nat];
            if (n <= 0 || d <= 0) return null;
            return new String[]{owner, utf8[n], utf8[d]};
        }

        /** 注解 type_index / 键名 / 枚举名这些 u2 直接指向 Utf8 条目 */
        String strConstPoolUtf8(int cpIndex) {
            return cpIndex > 0 && cpIndex < utf8.length && utf8[cpIndex] != null ? utf8[cpIndex] : "";
        }

        /** 注解元素值的数字常量（'B'..'D'、'J' 的 u2 指向 Integer/Long/… 条目） */
        Object numConst(int cpIndex) {
            return cpIndex > 0 && cpIndex < numConsts.length ? numConsts[cpIndex] : null;
        }
    }

    /** ACC_INTERFACE / ACC_ANNOTATION / ACC_SYNTHETIC，业务登记方要用 */
    static final int ACC_INTERFACE = 0x0200;
    static final int ACC_ANNOTATION = 0x2000;
    static final int ACC_SYNTHETIC = 0x1000;

    static ClassInfo parse(byte[] data) throws IOException {
        DataInputStream in = new DataInputStream(new ByteArrayInputStream(data));
        if (in.readInt() != 0xCAFEBABE) throw new IOException("不是 class 文件");
        in.readUnsignedShort(); // minor
        in.readUnsignedShort(); // major

        int cpCount = in.readUnsignedShort();
        String[] utf8 = new String[cpCount];
        int[] refClass = new int[cpCount];
        int[] refNat = new int[cpCount];
        int[] natName = new int[cpCount];
        int[] natDesc = new int[cpCount];
        int[] classNameIdx = new int[cpCount];
        Object[] numConsts = new Object[cpCount];
        for (int i = 1; i < cpCount; i++) {
            int tag = in.readUnsignedByte();
            switch (tag) {
                case 1: utf8[i] = in.readUTF(); break; // Utf8
                case 3: numConsts[i] = in.readInt(); break;    // Integer
                case 4: numConsts[i] = in.readFloat(); break;  // Float
                case 5: numConsts[i] = in.readLong(); i++; break; // Long 占两个槽
                case 6: numConsts[i] = in.readDouble(); i++; break; // Double 同上
                case 7: classNameIdx[i] = in.readUnsignedShort(); break; // Class
                case 8: in.readUnsignedShort(); break; // String 常量（ldc 用，注解字符串不经它）
                case 9: case 10: case 11: case 17: case 18: // Field/Method/IfMethod ref、Dynamic
                    refClass[i] = in.readUnsignedShort();
                    refNat[i] = in.readUnsignedShort();
                    break;
                case 12: // NameAndType
                    natName[i] = in.readUnsignedShort();
                    natDesc[i] = in.readUnsignedShort();
                    break;
                case 15: in.readUnsignedByte(); in.readUnsignedShort(); break; // MethodHandle
                case 16: case 19: case 20: in.readUnsignedShort(); break; // MethodType/Module/Package
                default: throw new IOException("未知常量池 tag " + tag);
            }
        }
        String[] classNames = new String[cpCount];
        for (int i = 1; i < cpCount; i++) {
            if (classNameIdx[i] > 0 && classNameIdx[i] < cpCount) classNames[i] = utf8[classNameIdx[i]];
        }

        int access = in.readUnsignedShort();
        int thisIdx = in.readUnsignedShort();
        int superIdx = in.readUnsignedShort();
        ClassInfo ci = new ClassInfo(access,
                nameAt(classNames, thisIdx),
                nameAt(classNames, superIdx),
                utf8, refClass, refNat, natName, natDesc, classNames, numConsts);
        int ifc = in.readUnsignedShort();
        for (int i = 0; i < ifc; i++) {
            ci.ifaces.add(nameAt(classNames, in.readUnsignedShort()));
        }

        int fieldCount = in.readUnsignedShort();
        for (int i = 0; i < fieldCount; i++) {
            int flags = in.readUnsignedShort();
            String fname = utf8OrEmpty(in, utf8);
            String fdesc = utf8OrEmpty(in, utf8);
            String sig = null;
            List<Anno> annos = new ArrayList<>();
            int attrCount = in.readUnsignedShort();
            for (int a = 0; a < attrCount; a++) {
                String aname = utf8OrEmpty(in, utf8);
                byte[] body = new byte[in.readInt()];
                in.readFully(body);
                if (aname.equals("Signature")) {
                    sig = utf8Attr(new DataInputStream(new ByteArrayInputStream(body)), utf8);
                } else if (aname.equals("RuntimeVisibleAnnotations") || aname.equals("RuntimeInvisibleAnnotations")) {
                    readAnnos(new DataInputStream(new ByteArrayInputStream(body)), ci, annos);
                }
            }
            ci.fields.add(new FieldInfo(flags, fname, fdesc, sig, annos));
        }

        int methodCount = in.readUnsignedShort();
        for (int i = 0; i < methodCount; i++) {
            int flags = in.readUnsignedShort();
            String mname = utf8OrEmpty(in, utf8);
            String mdesc = utf8OrEmpty(in, utf8);
            String sig = null;
            List<Anno> annos = new ArrayList<>();
            List<List<Anno>> paramAnnos = new ArrayList<>();
            byte[] code = null;
            int attrCount = in.readUnsignedShort();
            for (int a = 0; a < attrCount; a++) {
                String aname = utf8OrEmpty(in, utf8);
                byte[] body = new byte[in.readInt()];
                in.readFully(body);
                if (aname.equals("Signature")) {
                    sig = utf8Attr(new DataInputStream(new ByteArrayInputStream(body)), utf8);
                } else if (aname.equals("Code")) {
                    code = readCodeBytes(new DataInputStream(new ByteArrayInputStream(body)));
                } else if (aname.equals("RuntimeVisibleAnnotations") || aname.equals("RuntimeInvisibleAnnotations")) {
                    readAnnos(new DataInputStream(new ByteArrayInputStream(body)), ci, annos);
                } else if (aname.equals("RuntimeVisibleParameterAnnotations")
                        || aname.equals("RuntimeInvisibleParameterAnnotations")) {
                    readParamAnnos(new DataInputStream(new ByteArrayInputStream(body)), ci, paramAnnos);
                }
            }
            ci.methods.add(new MethodInfo(flags, mname, mdesc, sig, annos, paramAnnos, code));
        }

        int attrCount = in.readUnsignedShort();
        for (int a = 0; a < attrCount; a++) {
            String aname = utf8OrEmpty(in, utf8);
            byte[] body = new byte[in.readInt()];
            in.readFully(body);
            if (aname.equals("RuntimeVisibleAnnotations") || aname.equals("RuntimeInvisibleAnnotations")) {
                readAnnos(new DataInputStream(new ByteArrayInputStream(body)), ci, ci.annos);
            }
            // InnerClasses/BootstrapMethods/SourceFile/EnclosingMethod… 一律按长度跳过
        }
        return ci;
    }

    private static String nameAt(String[] classNames, int idx) {
        return idx > 0 && idx < classNames.length && classNames[idx] != null ? classNames[idx] : "";
    }

    private static String utf8OrEmpty(DataInputStream in, String[] utf8) throws IOException {
        int idx = in.readUnsignedShort();
        return idx > 0 && idx < utf8.length && utf8[idx] != null ? utf8[idx] : "";
    }

    /** Signature 等单 u2 属性体：就是常量池 Utf8 下标 */
    private static String utf8Attr(DataInputStream body, String[] utf8) throws IOException {
        int idx = body.readUnsignedShort();
        return idx > 0 && idx < utf8.length ? utf8[idx] : null;
    }

    /** Code 属性体：u2 stack, u2 locals, u4 len, 指令字节——只留指令区 */
    private static byte[] readCodeBytes(DataInputStream body) throws IOException {
        body.readUnsignedShort();
        body.readUnsignedShort();
        int len = body.readInt();
        if (len < 0 || len > 64 * 1024 * 1024) throw new IOException("Code 长度异常 " + len);
        byte[] code = new byte[len];
        body.readFully(code);
        return code;
    }

    /** annotation 结构（JVMS 4.7.16）：type_index u2 + 键值对 */
    private static void readAnnos(DataInputStream in, ClassInfo ci, List<Anno> out) throws IOException {
        int cnt = in.readUnsignedShort();
        for (int k = 0; k < cnt; k++) {
            Anno a = readAnno(in, ci);
            if (a != null) out.add(a);
        }
    }

    /**
     * RuntimeVisibleParameterAnnotations：num_parameters u1 → 每参数 num_annotations u2 + 注解。
     * 可见与不可见两份属性同下标合并（一般只有一份非空）。
     */
    private static void readParamAnnos(DataInputStream in, ClassInfo ci, List<List<Anno>> out) throws IOException {
        int params = in.readUnsignedByte();
        while (out.size() < params) out.add(new ArrayList<Anno>());
        for (int p = 0; p < params && p < out.size(); p++) {
            int cnt = in.readUnsignedShort();
            for (int k = 0; k < cnt; k++) {
                Anno a = readAnno(in, ci);
                if (a != null) out.get(p).add(a);
            }
        }
    }

    private static Anno readAnno(DataInputStream in, ClassInfo ci) throws IOException {
        String type = ci.strConstPoolUtf8(in.readUnsignedShort());
        Anno a = new Anno(simpleTypeName(type));
        int pairs = in.readUnsignedShort();
        for (int p = 0; p < pairs; p++) {
            String pname = ci.strConstPoolUtf8(in.readUnsignedShort());
            String v = elementValueText(in, ci);
            if (!pname.isEmpty() && v != null) a.attrs.put(pname, v);
        }
        return a;
    }

    /**
     * element_value：能落成文本的取文本，其余按结构吃完保证对齐。
     * 嵌套注解/非字符串值的语义源码侧也不细究（AnnoReaders 同口径），这里不冒进。
     */
    private static String elementValueText(DataInputStream in, ClassInfo ci) throws IOException {
        int tag = in.readUnsignedByte();
        switch (tag) {
            case 's': return ci.strConstPoolUtf8(in.readUnsignedShort()); // 注解字符串值直接指 Utf8 条目（JVMS 4.7.16.1，不走 String 中转）
            case 'B': case 'C': case 'I': case 'S': case 'Z': { // Integer 常量条目
                Object v = ci.numConst(in.readUnsignedShort());
                if (v == null) return null;
                return tag == 'Z' ? (((Integer) v) != 0 ? "true" : "false") : String.valueOf(v);
            }
            case 'J': { // Long
                Object v = ci.numConst(in.readUnsignedShort());
                return v == null ? null : String.valueOf(v);
            }
            case 'F': case 'D': { // Float/Double
                Object v = ci.numConst(in.readUnsignedShort());
                return v == null ? null : String.valueOf(v);
            }
            case 'e': { // 枚举：RequestMethod.POST（映射 method 属性照 AnnoReaders 口径 contains 判）
                String tn = ci.strConstPoolUtf8(in.readUnsignedShort());
                String cn = ci.strConstPoolUtf8(in.readUnsignedShort());
                return simpleTypeName(tn) + "." + cn;
            }
            case 'c': { // class 字面量：描述符 → 简名文本
                String d = ci.strConstPoolUtf8(in.readUnsignedShort());
                return Names.descriptorToText(d);
            }
            case '@': { // 嵌套注解：结构与顶层一样，语义不取（字节一定吃对齐）
                readAnno(in, ci);
                return null;
            }
            case '[': {
                int n = in.readUnsignedShort();
                StringBuilder sb = new StringBuilder("{");
                for (int k = 0; k < n; k++) {
                    if (k > 0) sb.append(", ");
                    String v = elementValueText(in, ci);
                    if (v != null) sb.append(v);
                }
                return sb.append('}').toString();
            }
            default: throw new IOException("未知 element_value tag " + tag);
        }
    }

    /** Ljavax/validation/constraints/NotNull; → NotNull；基本类型/数组描述符原样返回 */
    private static String simpleTypeName(String type) {
        if (type == null || type.isEmpty()) return "";
        String t = type;
        if (t.startsWith("L") && t.endsWith(";")) t = t.substring(1, t.length() - 1);
        int slash = t.lastIndexOf('/');
        return slash >= 0 ? t.substring(slash + 1) : t;
    }

    /**
     * 方法体里的指令长度表。只有 getfield/putfield/getstatic/putstatic 有消费价值，
     * 其余只为「跳到下一条」服务；tableswitch/lookupswitch 按 4 字节对齐展开。
     * 前提是 code 数组本身没坏——坏指令最多多走几步，越界由扫描循环的边界挡住。
     */
    static int instrLen(int op, byte[] code, int i) {
        switch (op) {
            case 0x10: // bipush
            case 0x12: // ldc
            case 0x15: case 0x16: case 0x17: case 0x18: case 0x19: // iload..aload
            case 0x36: case 0x37: case 0x38: case 0x39: case 0x3a: // istore..astore
            case 0xa9: // ret
            case 0xbc: // newarray
                return 2;
            case 0x11: // sipush
            case 0x13: case 0x14: // ldc_w, ldc2_w
            case 0x84: // iinc
            case 0x99: case 0x9a: case 0x9b: case 0x9c: case 0x9d: case 0x9e: // ifeq..ifle
            case 0x9f: case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: // if_icmp*
            case 0xa5: case 0xa6: // if_acmpeq/ne
            case 0xa7: case 0xa8: // goto, jsr
            case 0xb2: case 0xb3: case 0xb4: case 0xb5: // get/putstatic, get/putfield
            case 0xb6: case 0xb7: case 0xb8: // invokevirtual/special/static
            case 0xbb: case 0xbd: // new, anewarray
            case 0xc0: case 0xc1: // checkcast, instanceof
            case 0xc6: case 0xc7: // ifnull, ifnonnull
                return 3;
            case 0xb9: case 0xba: return 5; // invokeinterface, invokedynamic
            case 0xc5: return 4; // multianewarray
            case 0xc8: case 0xc9: return 5; // goto_w, jsr_w
            case 0xaa: return switchLen(code, i, true);  // tableswitch
            case 0xab: return switchLen(code, i, false); // lookupswitch
            case 0xc4: { // wide：iinc 是 6 字节，其余 4 字节
                int next = i + 1 < code.length ? code[i + 1] & 0xff : 0;
                return next == 0x84 ? 6 : 4;
            }
            default: return 1;
        }
    }

    private static int switchLen(byte[] code, int i, boolean table) {
        int p = i + 1;
        p += (4 - (p % 4)) % 4; // 操作数按 code 起点对齐到 4 字节
        p += 4; // default
        if (p + 4 > code.length) return code.length - i;
        int n;
        if (table) {
            int low = readInt(code, p);
            int high = readInt(code, p + 4);
            p += 8;
            if (high < low || high - low > 65535) return code.length - i;
            n = (high - low + 1) * 4;
        } else {
            int npairs = readInt(code, p);
            p += 4;
            if (npairs < 0 || npairs > 65535) return code.length - i;
            n = npairs * 8;
        }
        long end = p + (long) n;
        return end > code.length ? code.length - i : (int) (end - i);
    }

    private static int readInt(byte[] b, int off) {
        return ((b[off] & 0xff) << 24) | ((b[off + 1] & 0xff) << 16)
                | ((b[off + 2] & 0xff) << 8) | (b[off + 3] & 0xff);
    }
}
