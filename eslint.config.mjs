import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ignores: ['node_modules/**', '.commandcode/**']},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		languageOptions: {
			globals: {
				process: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
				setImmediate: 'readonly',
			},
		},
	},
);
