import { baseStyles } from "./style-modules/base.js";
import { codeStyles } from "./style-modules/code.js";
import { componentStyles } from "./style-modules/components.js";
import { tokenStyles } from "./style-modules/tokens.js";

export const styles = [tokenStyles, baseStyles, componentStyles, codeStyles].join("\n");
