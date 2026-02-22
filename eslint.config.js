import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['dist/**']
    },
    {
        rules: {
            'quotes': ['warn', 'single'],
            'indent': ['warn', 4, { 'SwitchCase': 1 }],
            'linebreak-style': ['warn', 'unix'],
            'semi': ['warn', 'always'],
            'comma-dangle': ['warn', 'never'],
            'dot-notation': 'warn',
            'eqeqeq': 'warn',
            'curly': ['warn', 'all'],
            'brace-style': ['warn'],
            'prefer-arrow-callback': ['warn'],
            'max-len': ['warn', 140],
            'no-console': ['warn'],
            'lines-between-class-members': ['warn', 'always', { 'exceptAfterSingleLine': true }],
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off'
        }
    },
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module'
        }
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended
);
