export function greet(name: string): string {
  return `Hello, ${name}`;
}

export class Greeter {
  constructor(private readonly name: string) {}

  sayHello(): string {
    return greet(this.name);
  }
}

export const DEFAULT_MESSAGE = "Needle says hello";
