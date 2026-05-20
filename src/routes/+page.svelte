<script lang="ts">
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { onMount } from 'svelte';

    onMount(() => goto(resolve('/a2a')));
</script>

<p class="text-sm text-gray-500">Redirecting to /a2a...</p>
